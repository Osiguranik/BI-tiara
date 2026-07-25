import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { query, GatewayConfig } from './gateway'

type Bindings = {
  GW_URL: string
  GW_KEY_ID: string
  GW_SECRET: string
}

const app = new Hono<{ Bindings: Bindings }>()

app.use('/api/*', cors())

// Helper - kreira gateway config iz env
function gw(env: Bindings): GatewayConfig {
  return {
    url: env.GW_URL,
    keyId: env.GW_KEY_ID,
    secret: env.GW_SECRET,
  }
}

// Helper - parsira date parametre iz query stringa
function dateRange(from?: string, to?: string) {
  const f = from || new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]
  const t = to || new Date().toISOString().split('T')[0]
  return { from: f, to: t }
}

// ─────────────────────────────────────────────
// MODUL: PREGLED (KPI kartice)
// ─────────────────────────────────────────────
app.get('/api/kpi', async (c) => {
  const { from, to } = dateRange(c.req.query('from'), c.req.query('to'))
  const g = gw(c.env)

  const [rezTotal, rezStatus, payments, providerDue, marzaKpi] = await Promise.all([
    query(g, `SELECT
                COUNT(*) as total,
                SUM(CASE WHEN status='accepted' THEN price ELSE 0 END) as ukupno_eur,
                SUM(CASE WHEN status='accepted' THEN net_price ELSE 0 END) as ukupno_net,
                COUNT(CASE WHEN status='accepted' THEN 1 END) as prihvacene_cnt
              FROM reservations
              WHERE is_draft=0 AND created_at BETWEEN ? AND DATE_ADD(?, INTERVAL 1 DAY)`,
      [from, to]),

    query(g, `SELECT status, COUNT(*) as cnt FROM reservations
              WHERE is_draft=0 AND created_at BETWEEN ? AND DATE_ADD(?, INTERVAL 1 DAY)
              GROUP BY status`, [from, to]),

    query(g, `SELECT SUM(amount_eur) as naplaceno_eur, SUM(amount_rsd) as naplaceno_rsd, COUNT(*) as cnt
              FROM payments
              WHERE storno=0 AND paid_at BETWEEN ? AND DATE_ADD(?, INTERVAL 1 DAY)`, [from, to]),

    query(g, `SELECT SUM(pi.amount) as duguje_eur
              FROM provider_invoices pi
              LEFT JOIN provider_invoice_payments pip ON pip.provider_invoice_id = pi.id
              WHERE pi.currency='EUR' AND pip.id IS NULL`, []),

    query(g, `SELECT
                SUM(price - net_price) as gross_marza,
                SUM(CASE
                  WHEN commission_type='percent' THEN ROUND(price * commission_value / 100, 2)
                  WHEN commission_type='fixed'   THEN commission_value
                  ELSE 0
                END) as komisije_agencijama,
                SUM((price - net_price) - CASE
                  WHEN commission_type='percent' THEN ROUND(price * commission_value / 100, 2)
                  WHEN commission_type='fixed'   THEN commission_value
                  ELSE 0
                END) as nasa_marza
              FROM reservations
              WHERE is_draft=0 AND status='accepted' AND net_price > 0
                AND created_at BETWEEN ? AND DATE_ADD(?, INTERVAL 1 DAY)`,
      [from, to]),
  ])

  return c.json({
    rezervacije: rezTotal.data?.rows[0] || {},
    statusi: rezStatus.data?.rows || [],
    placanja: payments.data?.rows[0] || {},
    dugovanje_provajderima: providerDue.data?.rows[0] || {},
    marza: marzaKpi.data?.rows[0] || {},
  })
})

// ─────────────────────────────────────────────
// MODUL: FINANSIJE
// ─────────────────────────────────────────────
app.get('/api/finansije/trend', async (c) => {
  const { from, to } = dateRange(c.req.query('from'), c.req.query('to'))
  const g = gw(c.env)

  const [prihodi, naplate, marza] = await Promise.all([
    query(g, `SELECT DATE_FORMAT(created_at, '%Y-%m') as mesec,
                     COUNT(*) as broj_rezervacija,
                     SUM(price) as prihod_eur,
                     SUM(net_price) as net_eur
              FROM reservations
              WHERE is_draft=0 AND status='accepted'
                AND created_at BETWEEN ? AND DATE_ADD(?, INTERVAL 1 DAY)
              GROUP BY mesec ORDER BY mesec`, [from, to]),

    query(g, `SELECT DATE_FORMAT(paid_at, '%Y-%m') as mesec,
                     SUM(amount_eur) as naplaceno_eur,
                     SUM(amount_rsd) as naplaceno_rsd,
                     COUNT(*) as broj_uplata
              FROM payments
              WHERE storno=0 AND paid_at BETWEEN ? AND DATE_ADD(?, INTERVAL 1 DAY)
              GROUP BY mesec ORDER BY mesec`, [from, to]),

    query(g, `SELECT DATE_FORMAT(created_at, '%Y-%m') as mesec,
                     SUM(price - net_price) as gross_marza,
                     SUM(CASE
                       WHEN commission_type='percent' THEN ROUND(price * commission_value / 100, 2)
                       WHEN commission_type='fixed'   THEN commission_value
                       ELSE 0
                     END) as komisije_agencijama,
                     SUM((price - net_price) - CASE
                       WHEN commission_type='percent' THEN ROUND(price * commission_value / 100, 2)
                       WHEN commission_type='fixed'   THEN commission_value
                       ELSE 0
                     END) as nasa_marza,
                     AVG(CASE WHEN price > 0 THEN (price - net_price)/price*100 ELSE 0 END) as gross_marza_pct
              FROM reservations
              WHERE is_draft=0 AND status='accepted' AND net_price > 0
                AND created_at BETWEEN ? AND DATE_ADD(?, INTERVAL 1 DAY)
              GROUP BY mesec ORDER BY mesec`, [from, to]),
  ])

  return c.json({
    prihodi: prihodi.data?.rows || [],
    naplate: naplate.data?.rows || [],
    marza: marza.data?.rows || [],
  })
})

app.get('/api/finansije/obroci', async (c) => {
  const g = gw(c.env)
  const status = c.req.query('status') || 'pending'

  const result = await query(g,
    `SELECT pi.due_at, pi.amount, pi.currency, pi.percentage,
            r.reference, r.price, r.hotel_name, r.checkin,
            u.name as agencija
     FROM payment_installments pi
     JOIN reservations r ON r.id = pi.reservation_id
     LEFT JOIN users u ON u.id = r.user_id
     WHERE pi.status = ?
     ORDER BY pi.due_at ASC
     LIMIT 100`, [status])

  return c.json(result.data?.rows || [])
})

app.get('/api/finansije/bankovni-izvodi', async (c) => {
  const { from, to } = dateRange(c.req.query('from'), c.req.query('to'))
  const g = gw(c.env)

  const [izvodi, stats] = await Promise.all([
    query(g, `SELECT bs.datum_izvoda, bs.broj_izvoda, bs.prethodno_stanje,
                     bs.novo_stanje, bs.potrazni_promet, bs.partija
              FROM bank_statements bs
              WHERE bs.datum_izvoda BETWEEN ? AND ?
              ORDER BY bs.datum_izvoda DESC
              LIMIT 50`, [from, to]),

    query(g, `SELECT SUM(bsi.iznos_rsd) as ukupno_rsd,
                     COUNT(*) as broj_stavki,
                     COUNT(CASE WHEN bsi.reservation_id IS NOT NULL THEN 1 END) as matched,
                     COUNT(CASE WHEN bsi.reservation_id IS NULL THEN 1 END) as unmatched
              FROM bank_statement_items bsi
              JOIN bank_statements bs ON bs.id = bsi.bank_statement_id
              WHERE bs.datum_izvoda BETWEEN ? AND ?`, [from, to]),
  ])

  return c.json({
    izvodi: izvodi.data?.rows || [],
    stats: stats.data?.rows[0] || {},
  })
})

app.get('/api/finansije/kurs', async (c) => {
  const g = gw(c.env)
  const result = await query(g,
    `SELECT date, value FROM exchange_rates ORDER BY date DESC LIMIT 90`)
  return c.json(result.data?.rows || [])
})

app.get('/api/finansije/raspodela-marze', async (c) => {
  const { from, to } = dateRange(c.req.query('from'), c.req.query('to'))
  const g = gw(c.env)

  const [mesecni, godisnji] = await Promise.all([
    query(g, `SELECT DATE_FORMAT(created_at, '%Y-%m') as mesec,
                     SUM(net_price) as net_troskovi,
                     SUM(CASE
                       WHEN commission_type='percent' THEN ROUND(price * commission_value / 100, 2)
                       WHEN commission_type='fixed'   THEN commission_value
                       ELSE 0
                     END) as komisije_agencijama,
                     SUM((price - net_price) - CASE
                       WHEN commission_type='percent' THEN ROUND(price * commission_value / 100, 2)
                       WHEN commission_type='fixed'   THEN commission_value
                       ELSE 0
                     END) as nasa_marza,
                     SUM(price) as ukupan_prihod,
                     SUM(price - net_price) as gross_marza
              FROM reservations
              WHERE is_draft=0 AND status='accepted' AND net_price > 0
                AND created_at BETWEEN ? AND DATE_ADD(?, INTERVAL 1 DAY)
              GROUP BY mesec ORDER BY mesec`,
      [from, to]),

    query(g, `SELECT
                SUM(net_price) as net_troskovi,
                SUM(CASE
                  WHEN commission_type='percent' THEN ROUND(price * commission_value / 100, 2)
                  WHEN commission_type='fixed'   THEN commission_value
                  ELSE 0
                END) as komisije_agencijama,
                SUM((price - net_price) - CASE
                  WHEN commission_type='percent' THEN ROUND(price * commission_value / 100, 2)
                  WHEN commission_type='fixed'   THEN commission_value
                  ELSE 0
                END) as nasa_marza,
                SUM(price) as ukupan_prihod,
                SUM(price - net_price) as gross_marza,
                COUNT(*) as broj_rezervacija
              FROM reservations
              WHERE is_draft=0 AND status='accepted' AND net_price > 0
                AND created_at BETWEEN ? AND DATE_ADD(?, INTERVAL 1 DAY)`,
      [from, to]),
  ])

  return c.json({
    mesecni: mesecni.data?.rows || [],
    godisnji: godisnji.data?.rows[0] || {},
  })
})

// ─────────────────────────────────────────────
// MODUL: REZERVACIJE
// ─────────────────────────────────────────────
app.get('/api/rezervacije/trend', async (c) => {
  const { from, to } = dateRange(c.req.query('from'), c.req.query('to'))
  const g = gw(c.env)

  const [trend, statusi, plStatus, nocenja, nacin] = await Promise.all([
    query(g, `SELECT DATE_FORMAT(created_at, '%Y-%m') as mesec,
                     COUNT(*) as ukupno,
                     SUM(CASE WHEN status='accepted' THEN 1 ELSE 0 END) as prihvacene,
                     SUM(CASE WHEN status='rejected' THEN 1 ELSE 0 END) as odbijene,
                     SUM(CASE WHEN status LIKE 'cancelled%' THEN 1 ELSE 0 END) as otkazane,
                     SUM(price) as prihod
              FROM reservations
              WHERE is_draft=0 AND created_at BETWEEN ? AND DATE_ADD(?, INTERVAL 1 DAY)
              GROUP BY mesec ORDER BY mesec`, [from, to]),

    query(g, `SELECT status, COUNT(*) as cnt, SUM(price) as vrednost
              FROM reservations
              WHERE is_draft=0 AND created_at BETWEEN ? AND DATE_ADD(?, INTERVAL 1 DAY)
              GROUP BY status`, [from, to]),

    query(g, `SELECT payment_status, COUNT(*) as cnt, SUM(price) as vrednost
              FROM reservations
              WHERE is_draft=0 AND created_at BETWEEN ? AND DATE_ADD(?, INTERVAL 1 DAY)
              GROUP BY payment_status`, [from, to]),

    query(g, `SELECT nights, COUNT(*) as cnt, AVG(price) as avg_cena
              FROM reservations
              WHERE is_draft=0 AND nights IS NOT NULL AND nights > 0
                AND created_at BETWEEN ? AND DATE_ADD(?, INTERVAL 1 DAY)
              GROUP BY nights ORDER BY nights`, [from, to]),

    query(g, `SELECT COALESCE(payment_method, 'Nije navedeno') as nacin,
                     COUNT(*) as cnt, SUM(price) as vrednost
              FROM reservations
              WHERE is_draft=0 AND created_at BETWEEN ? AND DATE_ADD(?, INTERVAL 1 DAY)
              GROUP BY payment_method ORDER BY cnt DESC`, [from, to]),
  ])

  return c.json({
    trend: trend.data?.rows || [],
    statusi: statusi.data?.rows || [],
    platni_status: plStatus.data?.rows || [],
    nocenja: nocenja.data?.rows || [],
    nacin_placanja: nacin.data?.rows || [],
  })
})

app.get('/api/rezervacije/po-statusu', async (c) => {
  const { from, to } = dateRange(c.req.query('from'), c.req.query('to'))
  const g = gw(c.env)
  const status = c.req.query('status') || 'accepted'
  const limit = parseInt(c.req.query('limit') || '100')
  const offset = parseInt(c.req.query('offset') || '0')

  const [rows, ukupno] = await Promise.all([
    query(g, `SELECT r.reference, r.status, r.payment_status,
                     r.price, r.net_price, r.nights, r.checkin,
                     r.hotel_name, r.created_at, r.payment_method,
                     r.commission_type, r.commission_value,
                     u.name as agencija
              FROM reservations r
              LEFT JOIN users u ON u.id = r.user_id
              WHERE r.is_draft=0 AND r.status=?
                AND r.created_at BETWEEN ? AND DATE_ADD(?, INTERVAL 1 DAY)
              ORDER BY r.created_at DESC
              LIMIT ? OFFSET ?`, [status, from, to, limit, offset]),

    query(g, `SELECT COUNT(*) as total, SUM(price) as ukupno_eur,
                     AVG(price) as prosecna_cena,
                     SUM(net_price) as ukupno_net,
                     AVG(nights) as avg_nocenja
              FROM reservations
              WHERE is_draft=0 AND status=?
                AND created_at BETWEEN ? AND DATE_ADD(?, INTERVAL 1 DAY)`,
      [status, from, to]),
  ])

  return c.json({
    rows: rows.data?.rows || [],
    stats: ukupno.data?.rows[0] || {},
  })
})

app.get('/api/rezervacije/otkazivanja', async (c) => {
  const { from, to } = dateRange(c.req.query('from'), c.req.query('to'))
  const g = gw(c.env)

  const result = await query(g,
    `SELECT rc.cancelled_at, rc.total_cost, rc.provider_amount,
            rc.agency_amount, rc.refund_amount, rc.currency, rc.paid_out,
            r.reference, r.price, r.hotel_name, r.checkin, r.nights,
            u.name as agencija
     FROM reservation_cancellations rc
     JOIN reservations r ON r.id = rc.reservation_id
     LEFT JOIN users u ON u.id = r.user_id
     WHERE rc.cancelled_at BETWEEN ? AND DATE_ADD(?, INTERVAL 1 DAY)
     ORDER BY rc.cancelled_at DESC
     LIMIT 100`, [from, to])

  return c.json(result.data?.rows || [])
})

app.get('/api/rezervacije/checkin-kalendar', async (c) => {
  const { from, to } = dateRange(c.req.query('from'), c.req.query('to'))
  const g = gw(c.env)

  const result = await query(g,
    `SELECT DATE_FORMAT(checkin, '%Y-%m') as mesec,
            COUNT(*) as dolasci,
            SUM(nights) as nocenja,
            SUM(price) as vrednost
     FROM reservations
     WHERE is_draft=0 AND status='accepted'
       AND checkin BETWEEN ? AND ?
     GROUP BY mesec ORDER BY mesec`, [from, to])

  return c.json(result.data?.rows || [])
})

// ─────────────────────────────────────────────
// MODUL: AGENCIJE
// ─────────────────────────────────────────────
app.get('/api/agencije/lista', async (c) => {
  const { from, to } = dateRange(c.req.query('from'), c.req.query('to'))
  const g = gw(c.env)
  const limit = parseInt(c.req.query('limit') || '50')

  const result = await query(g,
    `SELECT u.id, u.name, u.email, u.is_active,
            COUNT(r.id) as broj_rezervacija,
            SUM(CASE WHEN r.status='accepted' THEN 1 ELSE 0 END) as prihvacene,
            SUM(CASE WHEN r.status LIKE 'cancelled%' THEN 1 ELSE 0 END) as otkazane,
            SUM(r.price) as ukupan_prihod,
            AVG(r.price) as prosecna_vrednost,
            SUM(r.price - r.net_price) as gross_marza,
            SUM(CASE
              WHEN r.commission_type='percent' THEN ROUND(r.price * r.commission_value / 100, 2)
              WHEN r.commission_type='fixed'   THEN r.commission_value
              ELSE 0
            END) as komisija_agenciji,
            SUM((r.price - r.net_price) - CASE
              WHEN r.commission_type='percent' THEN ROUND(r.price * r.commission_value / 100, 2)
              WHEN r.commission_type='fixed'   THEN r.commission_value
              ELSE 0
            END) as nasa_marza,
            MAX(r.created_at) as poslednja_rezervacija
     FROM users u
     LEFT JOIN reservations r ON r.user_id=u.id AND r.is_draft=0
       AND r.created_at BETWEEN ? AND DATE_ADD(?, INTERVAL 1 DAY)
     WHERE u.role='agent'
     GROUP BY u.id, u.name, u.email, u.is_active
     HAVING broj_rezervacija > 0
     ORDER BY ukupan_prihod DESC
     LIMIT ?`, [from, to, limit])

  return c.json(result.data?.rows || [])
})

app.get('/api/agencije/trend', async (c) => {
  const { from, to } = dateRange(c.req.query('from'), c.req.query('to'))
  const g = gw(c.env)
  const agencijaId = c.req.query('id')

  if (agencijaId) {
    const result = await query(g,
      `SELECT DATE_FORMAT(r.created_at, '%Y-%m') as mesec,
              COUNT(*) as rezervacije,
              SUM(r.price) as prihod,
              SUM(r.price - r.net_price) as marza
       FROM reservations r
       WHERE r.user_id=? AND r.is_draft=0
         AND r.created_at BETWEEN ? AND DATE_ADD(?, INTERVAL 1 DAY)
       GROUP BY mesec ORDER BY mesec`, [agencijaId, from, to])
    return c.json(result.data?.rows || [])
  }

  // Top 10 agencija trend
  const result = await query(g,
    `SELECT DATE_FORMAT(r.created_at, '%Y-%m') as mesec,
            u.name as agencija,
            COUNT(*) as rezervacije,
            SUM(r.price) as prihod
     FROM reservations r
     JOIN users u ON u.id=r.user_id
     WHERE r.is_draft=0 AND r.status='accepted'
       AND r.created_at BETWEEN ? AND DATE_ADD(?, INTERVAL 1 DAY)
       AND r.user_id IN (
         SELECT user_id FROM reservations
         WHERE is_draft=0 AND status='accepted'
           AND created_at BETWEEN ? AND DATE_ADD(?, INTERVAL 1 DAY)
         GROUP BY user_id ORDER BY COUNT(*) DESC LIMIT 5
       )
     GROUP BY mesec, u.name ORDER BY mesec, prihod DESC`,
    [from, to, from, to])

  return c.json(result.data?.rows || [])
})

app.get('/api/agencije/rang', async (c) => {
  const { from, to } = dateRange(c.req.query('from'), c.req.query('to'))
  const g = gw(c.env)

  const result = await query(g,
    `SELECT u.name,
            COUNT(r.id) as rezervacije,
            SUM(r.price) as prihod,
            SUM(r.price - r.net_price) as gross_marza,
            SUM(CASE
              WHEN r.commission_type='percent' THEN ROUND(r.price * r.commission_value / 100, 2)
              WHEN r.commission_type='fixed'   THEN r.commission_value
              ELSE 0
            END) as komisija_agenciji,
            SUM((r.price - r.net_price) - CASE
              WHEN r.commission_type='percent' THEN ROUND(r.price * r.commission_value / 100, 2)
              WHEN r.commission_type='fixed'   THEN r.commission_value
              ELSE 0
            END) as nasa_marza,
            AVG(r.nights) as avg_nocenja,
            SUM(CASE WHEN r.status LIKE 'cancelled%' THEN 1 ELSE 0 END) as otkazivanja,
            ROUND(SUM(CASE WHEN r.status LIKE 'cancelled%' THEN 1 ELSE 0 END)*100.0/COUNT(*),1) as stopa_otkazivanja
     FROM users u
     JOIN reservations r ON r.user_id=u.id AND r.is_draft=0
       AND r.created_at BETWEEN ? AND DATE_ADD(?, INTERVAL 1 DAY)
     WHERE u.role='agent'
     GROUP BY u.id, u.name
     ORDER BY prihod DESC
     LIMIT 500`, [from, to])

  return c.json(result.data?.rows || [])
})

// ─────────────────────────────────────────────
// MODUL: PROVAJDERI
// ─────────────────────────────────────────────
app.get('/api/provajderi/lista', async (c) => {
  const { from, to } = dateRange(c.req.query('from'), c.req.query('to'))
  const g = gw(c.env)

  const result = await query(g,
    `SELECT p.id, p.name, p.company_name, p.markup_percent, p.enabled,
            COUNT(r.id) as rezervacije,
            SUM(r.price) as prihod_eur,
            SUM(r.net_price) as net_eur,
            SUM(r.price - r.net_price) as marza_eur
     FROM providers p
     LEFT JOIN reservations r ON r.provider_id=p.id AND r.is_draft=0
       AND r.status='accepted'
       AND r.created_at BETWEEN ? AND DATE_ADD(?, INTERVAL 1 DAY)
     GROUP BY p.id, p.name, p.company_name, p.markup_percent, p.enabled
     ORDER BY prihod_eur DESC`, [from, to])

  return c.json(result.data?.rows || [])
})

app.get('/api/provajderi/fakture', async (c) => {
  const { from, to } = dateRange(c.req.query('from'), c.req.query('to'))
  const g = gw(c.env)
  const provajderId = c.req.query('id')

  const whereProv = provajderId ? 'AND pi.provider_id=?' : ''
  const params = provajderId
    ? [from, to, provajderId]
    : [from, to]

  const [fakture, placanja] = await Promise.all([
    query(g,
      `SELECT pi.id, pi.invoice_number, pi.amount, pi.currency,
              pi.issued_at, pi.due_at, pi.description,
              p.name as provajder,
              COALESCE(SUM(pip.amount), 0) as placeno,
              (pi.amount - COALESCE(SUM(pip.amount), 0)) as ostatak
       FROM provider_invoices pi
       JOIN providers p ON p.id=pi.provider_id
       LEFT JOIN provider_invoice_payments pip ON pip.provider_invoice_id=pi.id
       WHERE pi.issued_at BETWEEN ? AND ? ${whereProv}
       GROUP BY pi.id, pi.invoice_number, pi.amount, pi.currency,
                pi.issued_at, pi.due_at, pi.description, p.name
       ORDER BY pi.due_at ASC
       LIMIT 100`, params),

    query(g,
      `SELECT p.name as provajder,
              pi.currency,
              SUM(pi.amount) as ukupno_fakturisano,
              COALESCE(SUM(pip_total.placeno), 0) as ukupno_placeno,
              SUM(pi.amount) - COALESCE(SUM(pip_total.placeno), 0) as duguje
       FROM provider_invoices pi
       JOIN providers p ON p.id=pi.provider_id
       LEFT JOIN (
         SELECT provider_invoice_id, SUM(amount) as placeno
         FROM provider_invoice_payments
         GROUP BY provider_invoice_id
       ) pip_total ON pip_total.provider_invoice_id=pi.id
       WHERE pi.issued_at BETWEEN ? AND ? ${whereProv}
       GROUP BY p.id, p.name, pi.currency
       ORDER BY duguje DESC`, params),
  ])

  return c.json({
    fakture: fakture.data?.rows || [],
    dugovanja: placanja.data?.rows || [],
  })
})

app.get('/api/provajderi/trend', async (c) => {
  const { from, to } = dateRange(c.req.query('from'), c.req.query('to'))
  const g = gw(c.env)

  const result = await query(g,
    `SELECT DATE_FORMAT(r.created_at, '%Y-%m') as mesec,
            p.name as provajder,
            COUNT(r.id) as rezervacije,
            SUM(r.net_price) as net_eur
     FROM reservations r
     JOIN providers p ON p.id=r.provider_id
     WHERE r.is_draft=0 AND r.status='accepted'
       AND r.created_at BETWEEN ? AND DATE_ADD(?, INTERVAL 1 DAY)
       AND r.provider_id IN (
         SELECT provider_id FROM reservations
         WHERE is_draft=0 AND status='accepted'
           AND created_at BETWEEN ? AND DATE_ADD(?, INTERVAL 1 DAY)
         GROUP BY provider_id ORDER BY COUNT(*) DESC LIMIT 6
       )
     GROUP BY mesec, p.name ORDER BY mesec, rezervacije DESC`,
    [from, to, from, to])

  return c.json(result.data?.rows || [])
})

// ─────────────────────────────────────────────
// MODUL: USLUGE
// ─────────────────────────────────────────────
app.get('/api/usluge/pregled', async (c) => {
  const { from, to } = dateRange(c.req.query('from'), c.req.query('to'))
  const g = gw(c.env)

  const [tipovi, trend, top] = await Promise.all([
    query(g,
      `SELECT type as tip,
              price_currency as valuta,
              COUNT(*) as broj,
              SUM(price) as ukupno,
              AVG(price) as prosek
       FROM services
       WHERE status != 'rejected'
         AND created_at BETWEEN ? AND DATE_ADD(?, INTERVAL 1 DAY)
       GROUP BY type, price_currency
       ORDER BY ukupno DESC`, [from, to]),

    query(g,
      `SELECT DATE_FORMAT(created_at, '%Y-%m') as mesec,
              type as tip,
              COUNT(*) as broj,
              SUM(price) as prihod,
              price_currency as valuta
       FROM services
       WHERE status != 'rejected'
         AND created_at BETWEEN ? AND DATE_ADD(?, INTERVAL 1 DAY)
       GROUP BY mesec, type, price_currency
       ORDER BY mesec`, [from, to]),

    query(g,
      `SELECT s.name as naziv, s.type as tip,
              COUNT(*) as broj, SUM(s.price) as prihod, s.price_currency as valuta,
              p.name as provajder
       FROM services s
       LEFT JOIN providers p ON p.id=s.provider_id
       WHERE s.status != 'rejected'
         AND s.created_at BETWEEN ? AND DATE_ADD(?, INTERVAL 1 DAY)
       GROUP BY s.name, s.type, s.price_currency, p.name
       ORDER BY broj DESC
       LIMIT 20`, [from, to]),
  ])

  return c.json({
    tipovi: tipovi.data?.rows || [],
    trend: trend.data?.rows || [],
    top_usluge: top.data?.rows || [],
  })
})

// ─────────────────────────────────────────────
// MODUL: ORGANIZATORI
// ─────────────────────────────────────────────
app.get('/api/organizatori/pregled', async (c) => {
  const { from, to } = dateRange(c.req.query('from'), c.req.query('to'))
  const g = gw(c.env)

  const result = await query(g,
    `SELECT o.name as organizator,
            COUNT(r.id) as rezervacije,
            SUM(r.price) as prihod,
            SUM(r.price - r.net_price) as marza,
            AVG(r.nights) as avg_nocenja
     FROM organizers o
     LEFT JOIN reservations r ON r.organizer_id=o.id AND r.is_draft=0
       AND r.created_at BETWEEN ? AND DATE_ADD(?, INTERVAL 1 DAY)
     GROUP BY o.id, o.name
     ORDER BY prihod DESC`, [from, to])

  return c.json(result.data?.rows || [])
})

// ─────────────────────────────────────────────
// FRONTEND - HTML
// ─────────────────────────────────────────────
app.get('/', (c) => {
  return c.html(html)
})

// ─────────────────────────────────────────────
// HTML APLIKACIJA
// ─────────────────────────────────────────────
const html = `<!DOCTYPE html>
<html lang="sr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Tiara Holidays — BI Dashboard</title>
<script src="https://cdn.tailwindcss.com"></script>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/axios@1.6.0/dist/axios.min.js"></script>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.4.0/css/all.min.css">
<style>
  * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
  body { font-family: 'Segoe UI', system-ui, sans-serif; background: #0f172a; color: #e2e8f0; overscroll-behavior: none; }
  ::-webkit-scrollbar { width: 4px; height: 4px; }
  ::-webkit-scrollbar-track { background: #1e293b; }
  ::-webkit-scrollbar-thumb { background: #475569; border-radius: 3px; }

  /* ── SIDEBAR ── */
  .sidebar { width: 240px; min-height: 100vh; background: #252d3a; border-right: 1px solid #2f3a4a; position: fixed; top: 0; left: 0; z-index: 200; transition: transform .3s cubic-bezier(.4,0,.2,1); overflow-y: auto; }
  .sidebar-link { display: flex; align-items: center; gap: 10px; padding: 11px 16px; border-radius: 8px; cursor: pointer; transition: all .2s; font-size: 14px; color: #94a3b8; margin: 2px 8px; }
  .sidebar-link:hover { background: #2f3a4a; color: #e2e8f0; }
  .sidebar-link.active { background: #3b82f6; color: #fff; }

  /* ── MAIN ── */
  .main { margin-left: 240px; padding: 24px; min-height: 100vh; }

  /* ── CARDS ── */
  .card { background: #1e293b; border: 1px solid #334155; border-radius: 12px; padding: 20px; }
  .kpi-card { background: linear-gradient(135deg, #1e293b, #0f172a); border: 1px solid #334155; border-radius: 12px; padding: 20px; position: relative; overflow: hidden; }
  .kpi-card::before { content:''; position:absolute; top:-30px; right:-30px; width:100px; height:100px; border-radius:50%; opacity:.1; }
  .kpi-blue::before { background:#3b82f6; }
  .kpi-green::before { background:#10b981; }
  .kpi-yellow::before { background:#f59e0b; }
  .kpi-red::before { background:#ef4444; }
  .kpi-purple::before { background:#8b5cf6; }

  /* ── BUTTONS ── */
  .btn { padding: 8px 16px; border-radius: 8px; border: none; cursor: pointer; font-size: 13px; font-weight: 500; transition: all .2s; touch-action: manipulation; }
  .btn-primary { background: #3b82f6; color: #fff; }
  .btn-primary:hover { background: #2563eb; }
  .btn-ghost { background: #334155; color: #94a3b8; }
  .btn-ghost:hover { background: #475569; color: #e2e8f0; }

  /* ── TABS ── */
  .tab { padding: 8px 14px; border-radius: 8px; cursor: pointer; font-size: 13px; color: #64748b; transition: all .2s; white-space: nowrap; touch-action: manipulation; }
  .tab.active { background: #3b82f6; color: #fff; }
  .tab:hover:not(.active) { background: #334155; color: #94a3b8; }

  /* ── INPUTS ── */
  input[type=date], select { background: #0f172a; border: 1px solid #334155; color: #e2e8f0; border-radius: 8px; padding: 8px 12px; font-size: 13px; outline: none; }
  input[type=date]:focus, select:focus { border-color: #3b82f6; }

  /* ── TABLE ── */
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th { background: #0f172a; padding: 10px 12px; text-align: left; color: #64748b; font-weight: 600; font-size: 11px; text-transform: uppercase; letter-spacing: .05em; border-bottom: 1px solid #334155; position: sticky; top: 0; z-index: 1; }
  td { padding: 10px 12px; border-bottom: 1px solid #1e293b; color: #cbd5e1; }
  tr:hover td { background: #1e293b; }

  /* ── BADGES ── */
  .badge { display:inline-block; padding:2px 8px; border-radius:999px; font-size:11px; font-weight:600; }
  .badge-green { background:#064e3b; color:#34d399; }
  .badge-red { background:#450a0a; color:#f87171; }
  .badge-yellow { background:#451a03; color:#fbbf24; }
  .badge-blue { background:#1e3a5f; color:#60a5fa; }
  .badge-gray { background:#1e293b; color:#94a3b8; }

  /* ── MISC ── */
  .loading { display:flex; align-items:center; justify-content:center; gap:8px; color:#64748b; padding:40px; }
  .spin { animation: spin 1s linear infinite; }
  @keyframes spin { from{transform:rotate(0deg)} to{transform:rotate(360deg)} }
  .chart-container { position:relative; width:100%; }
  .progress-bar { height:6px; background:#1e293b; border-radius:3px; overflow:hidden; }
  .progress-fill { height:100%; background: linear-gradient(90deg, #3b82f6, #8b5cf6); border-radius:3px; transition: width .6s ease; }

  /* ── OVERLAY ── */
  .sidebar-overlay { display:none; position:fixed; inset:0; background:rgba(0,0,0,.6); z-index:199; backdrop-filter:blur(2px); }
  .sidebar-overlay.show { display:block; }

  /* ── BOTTOM NAV (mobile) ── */
  .bottom-nav { display:none; position:fixed; bottom:0; left:0; right:0; z-index:150; background:#1a2235; border-top:1px solid #2f3a4a; padding:0; safe-area-inset-bottom: env(safe-area-inset-bottom); }
  .bottom-nav-inner { display:flex; align-items:stretch; height:60px; }
  .bottom-nav-item { flex:1; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:3px; cursor:pointer; color:#475569; font-size:10px; font-weight:500; transition:all .2s; border:none; background:none; padding:4px 2px; touch-action:manipulation; }
  .bottom-nav-item.active { color:#3b82f6; }
  .bottom-nav-item i { font-size:18px; }
  .bottom-nav-item span { font-size:9px; line-height:1; }

  /* ── TOPBAR (mobile) ── */
  .topbar { display:none; position:fixed; top:0; left:0; right:0; z-index:150; background:#1a2235; border-bottom:1px solid #2f3a4a; height:56px; align-items:center; padding:0 16px; gap:12px; }
  .topbar-title { flex:1; font-size:15px; font-weight:700; color:#f1f5f9; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .hamburger { width:40px; height:40px; border-radius:10px; background:#252d3a; border:none; color:#94a3b8; font-size:18px; cursor:pointer; display:flex; align-items:center; justify-content:center; flex-shrink:0; touch-action:manipulation; }

  /* ─────────────────────────────────────────
     MOBILE BREAKPOINT
  ───────────────────────────────────────── */
  @media (max-width: 768px) {
    /* layout */
    .sidebar { transform: translateX(-100%); box-shadow: 4px 0 24px rgba(0,0,0,.4); }
    .sidebar.open { transform: translateX(0); }
    .sidebar-bottom { display: none; } /* hide refresh button in sidebar on mobile */
    .main { margin-left: 0; padding: 12px 12px 80px; padding-top: 68px; }

    /* show mobile chrome */
    .topbar { display: flex; }
    .bottom-nav { display: block; padding-bottom: env(safe-area-inset-bottom); }

    /* header date filters — stack vertically */
    .header-row { flex-direction: column !important; align-items: flex-start !important; gap: 10px !important; }
    .header-filters { width: 100%; }
    .quick-tabs { overflow-x: auto; -webkit-overflow-scrolling: touch; width: 100%; }
    .date-inputs { display: flex; gap: 6px; width: 100%; }
    .date-inputs input { flex: 1; min-width: 0; font-size: 12px; padding: 7px 8px; }

    /* grids — single column on mobile */
    [style*="grid-template-columns:1fr 1fr"],
    [style*="grid-template-columns: 1fr 1fr"] { display: block !important; }
    [style*="grid-template-columns:1fr 1fr"] > *,
    [style*="grid-template-columns: 1fr 1fr"] > * { margin-bottom: 12px; }

    [style*="grid-template-columns:2fr 1fr"],
    [style*="grid-template-columns: 2fr 1fr"] { display: block !important; }
    [style*="grid-template-columns:2fr 1fr"] > *,
    [style*="grid-template-columns: 2fr 1fr"] > * { margin-bottom: 12px; }

    /* KPI cards — 2 per row */
    [style*="grid-template-columns:repeat(auto-fill,minmax(200px"] { grid-template-columns: repeat(2, 1fr) !important; gap: 10px !important; }
    [style*="grid-template-columns:repeat(auto-fill,minmax(185px"] { grid-template-columns: repeat(2, 1fr) !important; gap: 10px !important; }
    [style*="grid-template-columns:repeat(auto-fill,minmax(180px"] { grid-template-columns: repeat(2, 1fr) !important; gap: 10px !important; }
    [style*="grid-template-columns:repeat(auto-fill,minmax(160px"] { grid-template-columns: repeat(2, 1fr) !important; gap: 10px !important; }
    [style*="grid-template-columns:repeat(auto-fill,minmax(220px"] { grid-template-columns: repeat(2, 1fr) !important; gap: 10px !important; }

    /* KPI card typography - smaller on mobile */
    .kpi-card { padding: 14px 12px; }
    .kpi-card [style*="font-size:28px"] { font-size: 22px !important; }
    .kpi-card [style*="font-size:24px"] { font-size: 20px !important; }
    .kpi-card [style*="font-size:22px"] { font-size: 18px !important; }

    /* cards */
    .card { padding: 14px 12px; border-radius: 10px; }

    /* charts shorter on mobile */
    .chart-container[style*="height:300px"] { height: 220px !important; }
    .chart-container[style*="height:260px"] { height: 200px !important; }
    .chart-container[style*="height:280px"] { height: 200px !important; }
    .chart-container[style*="height:240px"] { height: 180px !important; }
    .chart-container[style*="height:220px"] { height: 180px !important; }
    .chart-container[style*="height:420px"] { height: 280px !important; }
    .chart-container[style*="height:380px"] { height: 260px !important; }

    /* tabs - horizontal scroll */
    [style*="display:flex;gap:6px;margin-bottom:20px"],
    [style*="display:flex;gap:6px;margin-bottom:20px;flex-wrap:wrap"] {
      flex-wrap: nowrap !important;
      overflow-x: auto !important;
      -webkit-overflow-scrolling: touch;
      padding-bottom: 4px;
      scrollbar-width: none;
    }
    [style*="display:flex;gap:6px;margin-bottom:20px"]::-webkit-scrollbar { display:none; }

    /* tables — horizontal scroll wrapper */
    .table-scroll { overflow-x: auto; -webkit-overflow-scrolling: touch; }
    table { font-size: 12px; min-width: 500px; }
    th, td { padding: 8px 10px; }

    /* page title hidden (shown in topbar) */
    .page-title-block { display: none !important; }

    /* tab font smaller */
    .tab { font-size: 12px; padding: 7px 12px; }

    /* input search full width */
    input[type=text][style*="width:220px"],
    input[type=text][style*="width:200px"] { width: 100% !important; }
  }

  @media (max-width: 400px) {
    /* very small phones - 1 KPI per row for the main overview */
    [style*="grid-template-columns:repeat(auto-fill,minmax(200px"] { grid-template-columns: 1fr !important; }
  }
</style>
</head>
<body>

<!-- OVERLAY za sidebar na mobilnom -->
<div class="sidebar-overlay" id="sidebar-overlay" onclick="closeSidebar()"></div>

<!-- TOPBAR (samo mobile) -->
<header class="topbar" id="topbar">
  <button class="hamburger" onclick="toggleSidebar()" aria-label="Meni">
    <i class="fas fa-bars"></i>
  </button>
  <div class="topbar-title" id="topbar-title">Tiara Holidays</div>
  <button class="hamburger" onclick="refreshAll()" aria-label="Osvezi" style="color:#3b82f6">
    <i class="fas fa-sync-alt"></i>
  </button>
</header>

<!-- SIDEBAR -->
<aside class="sidebar" id="sidebar">
  <div style="padding:16px 16px 10px">
    <div style="display:flex;flex-direction:column;align-items:center;gap:6px;margin-bottom:4px">
      <img src="data:image/png;base64,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" alt="Tiara Holidays" style="width:160px;height:auto;object-fit:contain;filter:brightness(1.1)" />
      <div style="font-size:11px;color:#475569;letter-spacing:.06em;text-transform:uppercase">BI Dashboard</div>
    </div>
  </div>

  <div style="padding:0 8px;margin-top:8px">
    <div style="font-size:10px;color:#475569;font-weight:600;letter-spacing:.08em;padding:8px 8px 4px;text-transform:uppercase">Pregled</div>
    <div class="sidebar-link active" onclick="showModule('pregled')" id="nav-pregled">
      <i class="fas fa-th-large" style="width:16px"></i> Glavni pregled
    </div>

    <div style="font-size:10px;color:#475569;font-weight:600;letter-spacing:.08em;padding:16px 8px 4px;text-transform:uppercase">Moduli</div>
    <div class="sidebar-link" onclick="showModule('finansije')" id="nav-finansije">
      <i class="fas fa-chart-line" style="width:16px"></i> Finansije
    </div>
    <div class="sidebar-link" onclick="showModule('rezervacije')" id="nav-rezervacije">
      <i class="fas fa-calendar-check" style="width:16px"></i> Rezervacije
    </div>
    <div class="sidebar-link" onclick="showModule('agencije')" id="nav-agencije">
      <i class="fas fa-building" style="width:16px"></i> Agencije
    </div>
    <div class="sidebar-link" onclick="showModule('provajderi')" id="nav-provajderi">
      <i class="fas fa-handshake" style="width:16px"></i> Provajderi
    </div>
    <div class="sidebar-link" onclick="showModule('usluge')" id="nav-usluge">
      <i class="fas fa-concierge-bell" style="width:16px"></i> Usluge
    </div>
    <div class="sidebar-link" onclick="showModule('organizatori')" id="nav-organizatori">
      <i class="fas fa-sitemap" style="width:16px"></i> Organizatori
    </div>
  </div>

  <div class="sidebar-bottom" style="position:absolute;bottom:16px;left:0;right:0;padding:0 16px">
    <div style="font-size:11px;color:#334155;text-align:center">Poslednje osveženo: <span id="last-refresh">-</span></div>
    <button class="btn btn-ghost" style="width:100%;margin-top:8px;font-size:12px" onclick="refreshAll()">
      <i class="fas fa-sync-alt"></i> Osvezi podatke
    </button>
  </div>
</aside>

<!-- MAIN -->
<main class="main">

  <!-- HEADER -->
  <div class="header-row" style="display:flex;align-items:center;justify-content:space-between;margin-bottom:24px;flex-wrap:wrap;gap:12px">
    <div class="page-title-block">
      <h1 id="page-title" style="font-size:22px;font-weight:700;color:#f1f5f9">Glavni pregled</h1>
      <div id="page-subtitle" style="font-size:13px;color:#64748b;margin-top:2px">Svi ključni pokazatelji na jednom mestu</div>
    </div>
    <div class="header-filters" style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
      <!-- Brzi filteri -->
      <div class="quick-tabs" style="display:flex;gap:4px;background:#1e293b;padding:4px;border-radius:10px">
        <button class="tab active" id="quick-mtd" onclick="setCurrentMonth(this)">Ovaj mesec</button>
        <button class="tab" id="quick-lm" onclick="setLastMonth(this)">Prošli mesec</button>
        <button class="tab" id="quick-ytd" onclick="setCurrentYear(this)">Ova godina</button>
      </div>
      <div class="date-inputs" style="display:flex;align-items:center;gap:6px">
        <input type="date" id="date-from" onchange="onDateChange()">
        <span style="color:#475569">—</span>
        <input type="date" id="date-to" onchange="onDateChange()">
      </div>
    </div>
  </div>

  <!-- SADRZAJ MODULA -->
  <div id="module-content"></div>

</main>

<script>
// ═══════════════════════════════════════════
// STATE & CONFIG
// ═══════════════════════════════════════════
let currentModule = 'pregled'
let charts = {}
let dateFrom = ''
let dateTo = ''

function initDates() {
  // Default: trenutni mesec (1. dan meseca → danas)
  const now = new Date()
  dateTo = now.toISOString().split('T')[0]
  dateFrom = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split('T')[0]
  document.getElementById('date-from').value = dateFrom
  document.getElementById('date-to').value = dateTo
}

function setCurrentMonth(btn) {
  document.querySelectorAll('.tab[id^=quick]').forEach(t => t.classList.remove('active'))
  btn.classList.add('active')
  const now = new Date()
  dateTo = now.toISOString().split('T')[0]
  dateFrom = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split('T')[0]
  document.getElementById('date-from').value = dateFrom
  document.getElementById('date-to').value = dateTo
  loadCurrentModule()
}

function setLastMonth(btn) {
  document.querySelectorAll('.tab[id^=quick]').forEach(t => t.classList.remove('active'))
  btn.classList.add('active')
  const now = new Date()
  const firstDayLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1)
  const lastDayLastMonth = new Date(now.getFullYear(), now.getMonth(), 0)
  dateFrom = firstDayLastMonth.toISOString().split('T')[0]
  dateTo = lastDayLastMonth.toISOString().split('T')[0]
  document.getElementById('date-from').value = dateFrom
  document.getElementById('date-to').value = dateTo
  loadCurrentModule()
}

function setCurrentYear(btn) {
  document.querySelectorAll('.tab[id^=quick]').forEach(t => t.classList.remove('active'))
  btn.classList.add('active')
  const now = new Date()
  dateFrom = new Date(now.getFullYear(), 0, 1).toISOString().split('T')[0]
  dateTo = now.toISOString().split('T')[0]
  document.getElementById('date-from').value = dateFrom
  document.getElementById('date-to').value = dateTo
  loadCurrentModule()
}

function onDateChange() {
  dateFrom = document.getElementById('date-from').value
  dateTo = document.getElementById('date-to').value
  document.querySelectorAll('.tab[id^=quick]').forEach(t => t.classList.remove('active'))
  loadCurrentModule()
}

function dateParams() {
  return \`from=\${dateFrom}&to=\${dateTo}\`
}

// ═══════════════════════════════════════════
// NAVIGACIJA
// ═══════════════════════════════════════════
const moduleConfig = {
  pregled:      { title: 'Glavni pregled',   sub: 'Svi ključni pokazatelji na jednom mestu' },
  finansije:    { title: 'Finansije',         sub: 'Prihodi, naplate, marža i bankovni izvodi' },
  rezervacije:  { title: 'Rezervacije',       sub: 'Trend, statusi, otkazivanja i check-in analiza' },
  agencije:     { title: 'Agencije',          sub: 'Rang lista, prihodi i performanse partnera' },
  provajderi:   { title: 'Provajderi',        sub: 'Fakture, plaćanja i dugovanja dobavljačima' },
  usluge:       { title: 'Usluge',            sub: 'Transfer, letovi, osiguranja i vize' },
  organizatori: { title: 'Organizatori',      sub: 'Pregled po organizatorima putovanja' },
}

function showModule(name) {
  currentModule = name
  document.querySelectorAll('.sidebar-link').forEach(l => l.classList.remove('active'))
  document.getElementById('nav-' + name)?.classList.add('active')
  document.getElementById('page-title').textContent = moduleConfig[name].title
  document.getElementById('page-subtitle').textContent = moduleConfig[name].sub
  loadCurrentModule()
}

function loadCurrentModule() {
  destroyCharts()
  const content = document.getElementById('module-content')
  content.innerHTML = '<div class="loading"><i class="fas fa-circle-notch spin fa-2x"></i><span>Učitavanje podataka...</span></div>'
  const fn = modules[currentModule]
  if (fn) fn()
}

function refreshAll() {
  document.getElementById('last-refresh').textContent = new Date().toLocaleTimeString('sr')
  loadCurrentModule()
}

// ═══════════════════════════════════════════
// CHART HELPERS
// ═══════════════════════════════════════════
const COLORS = ['#3b82f6','#10b981','#f59e0b','#ef4444','#8b5cf6','#06b6d4','#ec4899','#14b8a6','#f97316','#a855f7']
const CHART_DEFAULTS = {
  responsive: true,
  maintainAspectRatio: false,
  plugins: {
    legend: { labels: { color: '#94a3b8', font: { size: 12 } } },
    tooltip: { backgroundColor: '#0f172a', borderColor: '#334155', borderWidth: 1, titleColor: '#f1f5f9', bodyColor: '#94a3b8' }
  },
  scales: {
    x: { grid: { color: '#1e293b' }, ticks: { color: '#64748b' } },
    y: { grid: { color: '#1e293b' }, ticks: { color: '#64748b' } }
  }
}

function makeChart(id, type, data, options = {}) {
  destroyChart(id)
  const ctx = document.getElementById(id)
  if (!ctx) return null
  const cfg = { type, data, options: { ...CHART_DEFAULTS, ...options } }
  if (!cfg.options.scales && (type === 'pie' || type === 'doughnut')) delete cfg.options.scales
  charts[id] = new Chart(ctx, cfg)
  return charts[id]
}

function destroyChart(id) {
  if (charts[id]) { charts[id].destroy(); delete charts[id] }
}

function destroyCharts() {
  Object.keys(charts).forEach(id => { charts[id].destroy(); delete charts[id] })
}

// ═══════════════════════════════════════════
// FORMATIRANJE
// ═══════════════════════════════════════════
function fmt(n, dec=2) {
  if (n == null || n === '') return '—'
  const num = parseFloat(n)
  if (isNaN(num)) return '—'
  return num.toLocaleString('sr-RS', { minimumFractionDigits: dec, maximumFractionDigits: dec })
}
function fmtEur(n) { return n > 0 ? '€ ' + fmt(n) : '—' }
function fmtRsd(n) { return n > 0 ? fmt(n, 0) + ' RSD' : '—' }
function fmtInt(n) { return n == null ? '0' : parseInt(n).toLocaleString('sr-RS') }

const STATUS_LABELS = {
  none: 'Bez statusa', pending: 'Na čekanju', accepted: 'Prihvaćena',
  rejected: 'Odbijena', cancelled_refund: 'Otkazana (refund)',
  cancelled_transfer: 'Otkazana (prenos)', cancelled_penalty: 'Otkazana (kazna)',
  overpayment: 'Preplata'
}
const PAY_LABELS = { pending: 'Na čekanju', partial: 'Delimično', paid: 'Plaćeno', refunded: 'Refundirano', transferred: 'Preneto' }
const SERVICE_LABELS = { transfer: 'Transfer', flight_ticket: 'Avio karta', travel_health_insurance: 'Zdravstveno osig.', trip_cancellation_insurance: 'Osig. otkazivanja', visa: 'Viza' }

function statusBadge(s) {
  const cls = { accepted:'badge-green', rejected:'badge-red', pending:'badge-yellow', none:'badge-gray', cancelled_refund:'badge-red', cancelled_transfer:'badge-yellow', cancelled_penalty:'badge-red', overpayment:'badge-blue' }
  return \`<span class="badge \${cls[s]||'badge-gray'}">\${STATUS_LABELS[s]||s}</span>\`
}
function payBadge(s) {
  const cls = { paid:'badge-green', partial:'badge-yellow', pending:'badge-gray', refunded:'badge-blue', transferred:'badge-blue' }
  return \`<span class="badge \${cls[s]||'badge-gray'}">\${PAY_LABELS[s]||s}</span>\`
}

// ═══════════════════════════════════════════
// MODULE: PREGLED
// ═══════════════════════════════════════════
const modules = {

pregled: async () => {
  const [kpi, trend] = await Promise.all([
    axios.get(\`/api/kpi?\${dateParams()}\`),
    axios.get(\`/api/rezervacije/trend?\${dateParams()}\`)
  ])
  const d = kpi.data
  const statusi = d.statusi || []
  const prihvacene = statusi.find(s=>s.status==='accepted')?.cnt || 0
  const odbijene = statusi.find(s=>s.status==='rejected')?.cnt || 0
  const otkazane = statusi.filter(s=>s.status?.startsWith('cancelled')).reduce((a,s)=>a+parseInt(s.cnt||0),0)

  document.getElementById('module-content').innerHTML = \`
    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:16px;margin-bottom:24px">
      <div class="kpi-card kpi-blue">
        <div style="font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:.08em;margin-bottom:8px"><i class="fas fa-ticket-alt mr-1"></i> Ukupno rezervacija</div>
        <div style="font-size:28px;font-weight:700;color:#f1f5f9">\${fmtInt(d.rezervacije?.total)}</div>
        <div style="font-size:12px;color:#64748b;margin-top:4px">u izabranom periodu</div>
      </div>
      <div class="kpi-card kpi-green">
        <div style="font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:.08em;margin-bottom:8px"><i class="fas fa-euro-sign mr-1"></i> Ukupan prihod</div>
        <div style="font-size:24px;font-weight:700;color:#10b981">\${fmtEur(d.rezervacije?.ukupno_eur)}</div>
        <div style="font-size:12px;color:#64748b;margin-top:4px">samo prihvaćene (\${fmtInt(d.rezervacije?.prihvacene_cnt)})</div>
      </div>
      <div class="kpi-card kpi-purple">
        <div style="font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:.08em;margin-bottom:8px"><i class="fas fa-check-circle mr-1"></i> Naplaćeno (EUR)</div>
        <div style="font-size:24px;font-weight:700;color:#8b5cf6">\${fmtEur(d.placanja?.naplaceno_eur)}</div>
        <div style="font-size:12px;color:#64748b;margin-top:4px">\${fmtInt(d.placanja?.cnt)} uplata</div>
      </div>
      <div class="kpi-card kpi-yellow">
        <div style="font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:.08em;margin-bottom:8px"><i class="fas fa-check-double mr-1"></i> Prihvaćene rez.</div>
        <div style="font-size:28px;font-weight:700;color:#f59e0b">\${fmtInt(prihvacene)}</div>
        <div style="font-size:12px;color:#64748b;margin-top:4px">od \${fmtInt(d.rezervacije?.total)} kreiranih</div>
      </div>
      <div class="kpi-card kpi-red">
        <div style="font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:.08em;margin-bottom:8px"><i class="fas fa-times-circle mr-1"></i> Otkazano / Odbijeno</div>
        <div style="font-size:28px;font-weight:700;color:#ef4444">\${fmtInt(otkazane + parseInt(odbijene))}</div>
        <div style="font-size:12px;color:#64748b;margin-top:4px">\${otkazane} otkazano, \${odbijene} odbijeno</div>
      </div>
      <div class="kpi-card" style="background:linear-gradient(135deg,#1e293b,#0f172a);border:1px solid #334155;border-radius:12px;padding:20px;position:relative;overflow:hidden;">
        <div style="content:'';position:absolute;top:-30px;right:-30px;width:100px;height:100px;border-radius:50%;opacity:.1;background:#10b981"></div>
        <div style="font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:.08em;margin-bottom:8px"><i class="fas fa-chart-pie mr-1"></i> Naša marža (neto)</div>
        <div style="font-size:22px;font-weight:700;color:#10b981">\${fmtEur(d.marza?.nasa_marza)}</div>
        <div style="font-size:12px;color:#64748b;margin-top:4px">Gross: \${fmtEur(d.marza?.gross_marza)}</div>
        <div style="margin-top:8px;padding-top:8px;border-top:1px solid #1e3a5f">
          <div style="font-size:10px;color:#475569;text-transform:uppercase;letter-spacing:.06em;margin-bottom:2px">Bez PDV (−20%)</div>
          <div style="font-size:18px;font-weight:700;color:#34d399">\${fmtEur(d.marza?.nasa_marza * 0.80)}</div>
        </div>
      </div>
      <div class="kpi-card" style="background:linear-gradient(135deg,#1e293b,#0f172a);border:1px solid #334155;border-radius:12px;padding:20px;position:relative;overflow:hidden;">
        <div style="content:'';position:absolute;top:-30px;right:-30px;width:100px;height:100px;border-radius:50%;opacity:.1;background:#f59e0b"></div>
        <div style="font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:.08em;margin-bottom:8px"><i class="fas fa-handshake mr-1"></i> Komisije agencijama</div>
        <div style="font-size:22px;font-weight:700;color:#f59e0b">\${fmtEur(d.marza?.komisije_agencijama)}</div>
        <div style="font-size:12px;color:#64748b;margin-top:4px">\${d.marza?.gross_marza>0?fmt(d.marza.komisije_agencijama/d.marza.gross_marza*100,1)+'% od gross marže':'—'}</div>
      </div>
    </div>

    <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:24px">
      <div class="card">
        <div style="font-weight:600;margin-bottom:16px;font-size:14px;color:#f1f5f9"><i class="fas fa-chart-bar mr-2" style="color:#3b82f6"></i>Trend rezervacija po mesecima</div>
        <div class="chart-container" style="height:220px"><canvas id="chart-pregled-trend"></canvas></div>
      </div>
      <div class="card">
        <div style="font-weight:600;margin-bottom:16px;font-size:14px;color:#f1f5f9"><i class="fas fa-chart-pie mr-2" style="color:#10b981"></i>Statusi rezervacija</div>
        <div class="chart-container" style="height:220px"><canvas id="chart-pregled-status"></canvas></div>
      </div>
    </div>

    <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px">
      <div class="card">
        <div style="font-weight:600;margin-bottom:16px;font-size:14px;color:#f1f5f9"><i class="fas fa-money-bill-wave mr-2" style="color:#8b5cf6"></i>Naplate po mesecima (EUR)</div>
        <div class="chart-container" style="height:220px"><canvas id="chart-pregled-naplate"></canvas></div>
      </div>
      <div class="card">
        <div style="font-weight:600;margin-bottom:16px;font-size:14px;color:#f1f5f9"><i class="fas fa-info-circle mr-2" style="color:#f59e0b"></i>Platni status rezervacija</div>
        <div class="chart-container" style="height:220px"><canvas id="chart-pregled-platni"></canvas></div>
      </div>
    </div>
  \`

  const tData = trend.data
  const trendRows = tData.trend || []

  makeChart('chart-pregled-trend', 'bar', {
    labels: trendRows.map(r=>r.mesec),
    datasets: [
      { label: 'Prihvaćene', data: trendRows.map(r=>r.prihvacene), backgroundColor: '#10b981' },
      { label: 'Odbijene', data: trendRows.map(r=>r.odbijene), backgroundColor: '#ef4444' },
      { label: 'Otkazane', data: trendRows.map(r=>r.otkazane), backgroundColor: '#f59e0b' },
    ]
  }, { plugins: { ...CHART_DEFAULTS.plugins }, scales: { x: { stacked: true, grid:{color:'#1e293b'}, ticks:{color:'#64748b'} }, y: { stacked: true, grid:{color:'#1e293b'}, ticks:{color:'#64748b'} } } })

  const statusRows = tData.statusi || []
  makeChart('chart-pregled-status', 'doughnut', {
    labels: statusRows.map(r=>STATUS_LABELS[r.status]||r.status),
    datasets: [{ data: statusRows.map(r=>r.cnt), backgroundColor: COLORS }]
  }, { plugins: { legend: { position:'right', labels:{color:'#94a3b8',font:{size:11}} } } })

  // naplate
  const naplate = (await axios.get(\`/api/finansije/trend?\${dateParams()}\`)).data.naplate || []
  makeChart('chart-pregled-naplate', 'line', {
    labels: naplate.map(r=>r.mesec),
    datasets: [{ label: 'Naplaćeno (EUR)', data: naplate.map(r=>r.naplaceno_eur), borderColor:'#8b5cf6', backgroundColor:'rgba(139,92,246,.15)', fill:true, tension:.4 }]
  })

  const platniRows = tData.platni_status || []
  makeChart('chart-pregled-platni', 'doughnut', {
    labels: platniRows.map(r=>PAY_LABELS[r.payment_status]||r.payment_status),
    datasets: [{ data: platniRows.map(r=>r.cnt), backgroundColor: ['#10b981','#f59e0b','#64748b','#3b82f6','#8b5cf6'] }]
  }, { plugins: { legend: { position:'right', labels:{color:'#94a3b8',font:{size:11}} } } })
},

// ═══════════════════════════════════════════
// MODULE: FINANSIJE
// ═══════════════════════════════════════════
finansije: async () => {
  const data = (await axios.get(\`/api/finansije/trend?\${dateParams()}\`)).data

  document.getElementById('module-content').innerHTML = \`
    <div style="display:flex;gap:6px;margin-bottom:20px;flex-wrap:wrap">
      <button class="tab active" onclick="finTab('prihodi',this)">Prihodi & Marža</button>
      <button class="tab" onclick="finTab('raspodela',this)">🎯 Raspodela marže</button>
      <button class="tab" onclick="finTab('naplate',this)">Naplate</button>
      <button class="tab" onclick="finTab('obroci',this)">Obroci plaćanja</button>
      <button class="tab" onclick="finTab('bankovni',this)">Bankovni izvodi</button>
      <button class="tab" onclick="finTab('kurs',this)">Kursna lista</button>
    </div>
    <div id="fin-content"></div>
  \`
  window.finData = data
  finTab('prihodi', document.querySelector('.tab.active'))
},

// ═══════════════════════════════════════════
// MODULE: REZERVACIJE
// ═══════════════════════════════════════════
rezervacije: async () => {
  const data = (await axios.get(\`/api/rezervacije/trend?\${dateParams()}\`)).data

  document.getElementById('module-content').innerHTML = \`
    <div style="display:flex;gap:6px;margin-bottom:20px;flex-wrap:wrap">
      <button class="tab active" onclick="rezTab('trend',this)">Trend</button>
      <button class="tab" onclick="rezTab('statusi',this)">Statusi</button>
      <button class="tab" onclick="rezTab('nocenja',this)">Noćenja</button>
      <button class="tab" onclick="rezTab('otkazivanja',this)">Otkazivanja</button>
      <button class="tab" onclick="rezTab('checkin',this)">Check-in</button>
    </div>
    <div id="rez-content"></div>
  \`
  window.rezData = data
  rezTab('trend', document.querySelector('.tab.active'))
},

// ═══════════════════════════════════════════
// MODULE: AGENCIJE
// ═══════════════════════════════════════════
agencije: async () => {
  const [lista, rang] = await Promise.all([
    axios.get(\`/api/agencije/lista?\${dateParams()}&limit=50\`),
    axios.get(\`/api/agencije/rang?\${dateParams()}\`)
  ])

  document.getElementById('module-content').innerHTML = \`
    <div style="display:flex;gap:6px;margin-bottom:20px;flex-wrap:wrap">
      <button class="tab active" onclick="agtTab('rang',this)">Rang lista</button>
      <button class="tab" onclick="agtTab('grafikon',this)">Grafikon</button>
      <button class="tab" onclick="agtTab('tabela',this)">Detaljna tabela</button>
    </div>
    <div id="agt-content"></div>
  \`
  window.agtData = { lista: lista.data, rang: rang.data }
  agtTab('rang', document.querySelector('.tab.active'))
},

// ═══════════════════════════════════════════
// MODULE: PROVAJDERI
// ═══════════════════════════════════════════
provajderi: async () => {
  const [lista, fakture] = await Promise.all([
    axios.get(\`/api/provajderi/lista?\${dateParams()}\`),
    axios.get(\`/api/provajderi/fakture?\${dateParams()}\`)
  ])

  document.getElementById('module-content').innerHTML = \`
    <div style="display:flex;gap:6px;margin-bottom:20px;flex-wrap:wrap">
      <button class="tab active" onclick="prvTab('pregled',this)">Pregled</button>
      <button class="tab" onclick="prvTab('fakture',this)">Fakture & Dugovanja</button>
      <button class="tab" onclick="prvTab('trend',this)">Trend</button>
    </div>
    <div id="prv-content"></div>
  \`
  window.prvData = { lista: lista.data, fakture: fakture.data }
  prvTab('pregled', document.querySelector('.tab.active'))
},

// ═══════════════════════════════════════════
// MODULE: USLUGE
// ═══════════════════════════════════════════
usluge: async () => {
  const data = (await axios.get(\`/api/usluge/pregled?\${dateParams()}\`)).data

  document.getElementById('module-content').innerHTML = \`
    <div class="card" style="margin-bottom:16px">
      <div style="font-weight:600;margin-bottom:16px;font-size:14px;color:#f1f5f9"><i class="fas fa-concierge-bell mr-2" style="color:#3b82f6"></i>Tipovi usluga</div>
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:12px" id="usluge-kpi"></div>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:16px">
      <div class="card">
        <div style="font-weight:600;margin-bottom:16px;font-size:14px;color:#f1f5f9">Raspodela po tipu</div>
        <div class="chart-container" style="height:260px"><canvas id="chart-usluge-pie"></canvas></div>
      </div>
      <div class="card">
        <div style="font-weight:600;margin-bottom:16px;font-size:14px;color:#f1f5f9">Trend po mesecima</div>
        <div class="chart-container" style="height:260px"><canvas id="chart-usluge-trend"></canvas></div>
      </div>
    </div>
    <div class="card">
      <div style="font-weight:600;margin-bottom:16px;font-size:14px;color:#f1f5f9">Top usluge</div>
      <div style="overflow:auto;max-height:300px" id="usluge-tabela"></div>
    </div>
  \`

  const tipovi = data.tipovi || []
  const kpiEl = document.getElementById('usluge-kpi')
  tipovi.forEach((t,i) => {
    kpiEl.innerHTML += \`
      <div style="background:#0f172a;border-radius:10px;padding:14px;border:1px solid #334155">
        <div style="font-size:11px;color:#64748b;margin-bottom:6px">\${SERVICE_LABELS[t.tip]||t.tip}</div>
        <div style="font-size:20px;font-weight:700;color:\${COLORS[i]}">\${fmtInt(t.broj)}</div>
        <div style="font-size:12px;color:#475569;margin-top:4px">\${t.valuta==='EUR'?fmtEur(t.ukupno):fmtRsd(t.ukupno)}</div>
      </div>
    \`
  })

  // Grupiši samo RSD za pie
  const rsdTipovi = tipovi.filter(t=>t.valuta==='RSD')
  makeChart('chart-usluge-pie', 'doughnut', {
    labels: rsdTipovi.map(t=>SERVICE_LABELS[t.tip]||t.tip),
    datasets: [{ data: rsdTipovi.map(t=>t.broj), backgroundColor: COLORS }]
  }, { plugins: { legend: { position:'right', labels:{color:'#94a3b8',font:{size:11}} } } })

  const trendRows = data.trend || []
  const meseci = [...new Set(trendRows.map(r=>r.mesec))].sort()
  const tipSet = [...new Set(trendRows.map(r=>r.tip))]
  makeChart('chart-usluge-trend', 'bar', {
    labels: meseci,
    datasets: tipSet.map((tip,i) => ({
      label: SERVICE_LABELS[tip]||tip,
      data: meseci.map(m => { const r = trendRows.find(x=>x.mesec===m&&x.tip===tip); return r?.broj||0 }),
      backgroundColor: COLORS[i]
    }))
  }, { scales: { x:{stacked:true,grid:{color:'#1e293b'},ticks:{color:'#64748b'}}, y:{stacked:true,grid:{color:'#1e293b'},ticks:{color:'#64748b'}} } })

  const topUsluge = data.top_usluge || []
  document.getElementById('usluge-tabela').innerHTML = \`
    <table><thead><tr>
      <th>Naziv</th><th>Tip</th><th>Provajder</th><th>Broj</th><th>Prihod</th>
    </tr></thead><tbody>
    \${topUsluge.map(u=>\`<tr>
      <td>\${u.naziv||'—'}</td>
      <td><span class="badge badge-blue">\${SERVICE_LABELS[u.tip]||u.tip}</span></td>
      <td>\${u.provajder||'—'}</td>
      <td style="font-weight:600">\${fmtInt(u.broj)}</td>
      <td>\${u.valuta==='EUR'?fmtEur(u.prihod):fmtRsd(u.prihod)}</td>
    </tr>\`).join('')}
    </tbody></table>
  \`
},

// ═══════════════════════════════════════════
// MODULE: ORGANIZATORI
// ═══════════════════════════════════════════
organizatori: async () => {
  const data = (await axios.get(\`/api/organizatori/pregled?\${dateParams()}\`)).data

  document.getElementById('module-content').innerHTML = \`
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:16px">
      <div class="card">
        <div style="font-weight:600;margin-bottom:16px;font-size:14px;color:#f1f5f9">Prihodi po organizatoru</div>
        <div class="chart-container" style="height:260px"><canvas id="chart-org-prihod"></canvas></div>
      </div>
      <div class="card">
        <div style="font-weight:600;margin-bottom:16px;font-size:14px;color:#f1f5f9">Broj rezervacija</div>
        <div class="chart-container" style="height:260px"><canvas id="chart-org-rez"></canvas></div>
      </div>
    </div>
    <div class="card">
      <div style="font-weight:600;margin-bottom:16px;font-size:14px;color:#f1f5f9">Detalji po organizatoru</div>
      <div style="overflow:auto">
        <table><thead><tr>
          <th>Organizator</th><th>Rezervacije</th><th>Prihod</th><th>Marža</th><th>Avg. noćenja</th>
        </tr></thead><tbody>
        \${data.map(o=>\`<tr>
          <td style="font-weight:600">\${o.organizator}</td>
          <td>\${fmtInt(o.rezervacije)}</td>
          <td style="color:#10b981">\${fmtEur(o.prihod)}</td>
          <td style="color:#8b5cf6">\${fmtEur(o.marza)}</td>
          <td>\${o.avg_nocenja?parseFloat(o.avg_nocenja).toFixed(1):'—'}</td>
        </tr>\`).join('')}
        </tbody></table>
      </div>
    </div>
  \`

  makeChart('chart-org-prihod', 'bar', {
    labels: data.map(r=>r.organizator),
    datasets: [{ label:'Prihod (EUR)', data:data.map(r=>r.prihod), backgroundColor: COLORS }]
  }, { indexAxis:'y' })

  makeChart('chart-org-rez', 'bar', {
    labels: data.map(r=>r.organizator),
    datasets: [{ label:'Rezervacije', data:data.map(r=>r.rezervacije), backgroundColor:'#3b82f6' }]
  }, { indexAxis:'y' })
}

} // end modules

// ═══════════════════════════════════════════
// FINANSIJE TABOVI
// ═══════════════════════════════════════════
async function finTab(tab, btn) {
  document.querySelectorAll('#module-content .tab').forEach(t=>t.classList.remove('active'))
  btn.classList.add('active')
  const content = document.getElementById('fin-content')
  destroyCharts()

  if (tab === 'prihodi') {
    const d = window.finData
    const prihodi = d.prihodi || []
    const marza = d.marza || []
    const totalPrihod = prihodi.reduce((a,r)=>a+parseFloat(r.prihod_eur||0),0)
    const totalNet = prihodi.reduce((a,r)=>a+parseFloat(r.net_eur||0),0)
    const totalGross = marza.reduce((a,r)=>a+parseFloat(r.gross_marza||0),0)
    const totalKomisije = marza.reduce((a,r)=>a+parseFloat(r.komisije_agencijama||0),0)
    const totalNasaMarza = marza.reduce((a,r)=>a+parseFloat(r.nasa_marza||0),0)
    const avgGrossPct = marza.reduce((a,r)=>a+parseFloat(r.gross_marza_pct||0),0)/Math.max(marza.length,1)
    content.innerHTML = \`
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(185px,1fr));gap:12px;margin-bottom:20px">
        <div class="kpi-card kpi-green">
          <div style="font-size:11px;color:#64748b;text-transform:uppercase;margin-bottom:8px"><i class="fas fa-euro-sign mr-1"></i>Ukupan prihod</div>
          <div style="font-size:22px;font-weight:700;color:#10b981">\${fmtEur(totalPrihod)}</div>
          <div style="font-size:11px;color:#475569;margin-top:4px">svi prihodi</div>
        </div>
        <div class="kpi-card kpi-blue">
          <div style="font-size:11px;color:#64748b;text-transform:uppercase;margin-bottom:8px"><i class="fas fa-building mr-1"></i>Net troškovi</div>
          <div style="font-size:22px;font-weight:700;color:#3b82f6">\${fmtEur(totalNet)}</div>
          <div style="font-size:11px;color:#475569;margin-top:4px">\${totalPrihod>0?fmt(totalNet/totalPrihod*100,1)+'% od prihoda':'—'}</div>
        </div>
        <div class="kpi-card kpi-purple">
          <div style="font-size:11px;color:#64748b;text-transform:uppercase;margin-bottom:8px"><i class="fas fa-layer-group mr-1"></i>Gross marža</div>
          <div style="font-size:22px;font-weight:700;color:#8b5cf6">\${fmtEur(totalGross)}</div>
          <div style="font-size:11px;color:#475569;margin-top:4px">\${avgGrossPct.toFixed(1)}% avg</div>
        </div>
        <div class="kpi-card kpi-yellow">
          <div style="font-size:11px;color:#64748b;text-transform:uppercase;margin-bottom:8px"><i class="fas fa-handshake mr-1"></i>Komisije agencijama</div>
          <div style="font-size:22px;font-weight:700;color:#f59e0b">\${fmtEur(totalKomisije)}</div>
          <div style="font-size:11px;color:#475569;margin-top:4px">\${totalGross>0?fmt(totalKomisije/totalGross*100,1)+'% od gross':'—'}</div>
        </div>
        <div class="kpi-card" style="background:linear-gradient(135deg,#052e16,#0f172a);border:1px solid #166534;border-radius:12px;padding:20px">
          <div style="font-size:11px;color:#64748b;text-transform:uppercase;margin-bottom:8px"><i class="fas fa-star mr-1" style="color:#10b981"></i>NAŠA MARŽA</div>
          <div style="font-size:22px;font-weight:700;color:#10b981">\${fmtEur(totalNasaMarza)}</div>
          <div style="font-size:11px;color:#475569;margin-top:4px">\${totalGross>0?fmt(totalNasaMarza/totalGross*100,1)+'% od gross':'—'}</div>
          <div style="margin-top:8px;padding-top:8px;border-top:1px solid #166534">
            <div style="font-size:10px;color:#475569;text-transform:uppercase;letter-spacing:.06em;margin-bottom:2px">Bez PDV (−20%)</div>
            <div style="font-size:18px;font-weight:700;color:#34d399">\${fmtEur(totalNasaMarza * 0.80)}</div>
          </div>
        </div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:16px">
        <div class="card">
          <div style="font-weight:600;margin-bottom:16px;font-size:14px;color:#f1f5f9"><i class="fas fa-chart-bar mr-2" style="color:#3b82f6"></i>Prihod i Net troškovi (EUR)</div>
          <div class="chart-container" style="height:260px"><canvas id="chart-fin-prihodi"></canvas></div>
        </div>
        <div class="card">
          <div style="font-weight:600;margin-bottom:16px;font-size:14px;color:#f1f5f9"><i class="fas fa-chart-bar mr-2" style="color:#8b5cf6"></i>Gross marža po mesecima</div>
          <div class="chart-container" style="height:260px"><canvas id="chart-fin-marza"></canvas></div>
        </div>
      </div>
      <div class="card">
        <div style="font-weight:600;margin-bottom:4px;font-size:14px;color:#f1f5f9"><i class="fas fa-layer-group mr-2" style="color:#10b981"></i>Raspodela marže po mesecima — 3 sloja</div>
        <div style="font-size:12px;color:#475569;margin-bottom:16px">Naša marža (zeleno) + Komisije agencijama (žuto) = Gross marža. Donji sloj je Net trošak.</div>
        <div class="chart-container" style="height:300px"><canvas id="chart-fin-stacked"></canvas></div>
      </div>
      <div class="card" style="margin-top:16px">
        <div style="font-weight:600;margin-bottom:4px;font-size:14px;color:#f1f5f9"><i class="fas fa-table mr-2" style="color:#34d399"></i>Mesečni pregled marže sa PDV obračunom</div>
        <div style="font-size:12px;color:#475569;margin-bottom:12px">Naša marža bez PDV = Naša marža × 0.80 (odbitak 20% PDV)</div>
        <div style="overflow:auto;max-height:320px">
          <table><thead><tr>
            <th>Mesec</th>
            <th>Prihod (EUR)</th>
            <th>Gross marža</th>
            <th style="color:#6ee7b7">Naša marža</th>
            <th style="color:#34d399">Naša marža bez PDV</th>
            <th>PDV (20%)</th>
          </tr></thead><tbody>
          \${marza.map((r,i)=>{
            const prihod = parseFloat(prihodi[i]?.prihod_eur||0)
            const nm = parseFloat(r.nasa_marza||0)
            const nmBezPdv = nm * 0.80
            const pdvIznos = nm * 0.20
            return \`<tr>
              <td style="font-weight:600">\${r.mesec}</td>
              <td style="color:#10b981">\${fmtEur(prihod)}</td>
              <td style="color:#8b5cf6">\${fmtEur(r.gross_marza)}</td>
              <td style="color:#10b981;font-weight:600">\${fmtEur(nm)}</td>
              <td style="color:#34d399;font-weight:700">\${fmtEur(nmBezPdv)}</td>
              <td style="color:#ef4444;font-size:12px">\${fmtEur(pdvIznos)}</td>
            </tr>\`
          }).join('')}
          <tr style="background:#0f172a;font-weight:700;border-top:2px solid #334155">
            <td style="color:#f1f5f9">UKUPNO</td>
            <td style="color:#10b981">\${fmtEur(totalPrihod)}</td>
            <td style="color:#8b5cf6">\${fmtEur(totalGross)}</td>
            <td style="color:#10b981">\${fmtEur(totalNasaMarza)}</td>
            <td style="color:#34d399">\${fmtEur(totalNasaMarza * 0.80)}</td>
            <td style="color:#ef4444">\${fmtEur(totalNasaMarza * 0.20)}</td>
          </tr>
          </tbody></table>
        </div>
      </div>
    \`
    makeChart('chart-fin-prihodi', 'bar', {
      labels: prihodi.map(r=>r.mesec),
      datasets: [
        { label:'Prihod (EUR)', data:prihodi.map(r=>r.prihod_eur), backgroundColor:'rgba(16,185,129,0.8)' },
        { label:'Net trošak (EUR)', data:prihodi.map(r=>r.net_eur), backgroundColor:'rgba(59,130,246,0.8)' }
      ]
    })
    makeChart('chart-fin-marza', 'bar', {
      labels: marza.map(r=>r.mesec),
      datasets: [
        { label:'Gross marža (EUR)', data:marza.map(r=>r.gross_marza), backgroundColor:'rgba(139,92,246,0.8)', yAxisID:'y' },
        { label:'Gross marža %', data:marza.map(r=>parseFloat(r.gross_marza_pct||0).toFixed(2)), borderColor:'#f59e0b', type:'line', yAxisID:'y1', tension:.4 }
      ]
    }, { scales: {
      x:{grid:{color:'#1e293b'},ticks:{color:'#64748b'}},
      y:{grid:{color:'#1e293b'},ticks:{color:'#64748b'}},
      y1:{position:'right',grid:{drawOnChartArea:false},ticks:{color:'#f59e0b',callback:v=>v+'%'}}
    }})
    // Stacked bar: net_troskovi + komisije + nasa_marza
    makeChart('chart-fin-stacked', 'bar', {
      labels: marza.map(r=>r.mesec),
      datasets: [
        { label:'Net trošak', data:prihodi.map(r=>r.net_eur||0), backgroundColor:'rgba(59,130,246,0.75)', stack:'stack' },
        { label:'Komisije agencijama', data:marza.map(r=>r.komisije_agencijama||0), backgroundColor:'rgba(245,158,11,0.85)', stack:'stack' },
        { label:'Naša marža', data:marza.map(r=>r.nasa_marza||0), backgroundColor:'rgba(16,185,129,0.9)', stack:'stack' },
      ]
    }, { scales: {
      x:{stacked:true,grid:{color:'#1e293b'},ticks:{color:'#64748b'}},
      y:{stacked:true,grid:{color:'#1e293b'},ticks:{color:'#64748b',callback:v=>'€'+v.toLocaleString()}}
    }})
  }

  else if (tab === 'raspodela') {
    const rData = (await axios.get(\`/api/finansije/raspodela-marze?\${dateParams()}\`)).data
    const mesecni = rData.mesecni || []
    const god = rData.godisnji || {}
    const totalPrihod = parseFloat(god.ukupan_prihod||0)
    const totalNet = parseFloat(god.net_troskovi||0)
    const totalGross = parseFloat(god.gross_marza||0)
    const totalKom = parseFloat(god.komisije_agencijama||0)
    const totalNasa = parseFloat(god.nasa_marza||0)
    content.innerHTML = \`
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:12px;margin-bottom:20px">
        <div class="kpi-card kpi-green">
          <div style="font-size:11px;color:#64748b;text-transform:uppercase;margin-bottom:8px"><i class="fas fa-euro-sign mr-1"></i>Ukupan prihod</div>
          <div style="font-size:22px;font-weight:700;color:#10b981">\${fmtEur(totalPrihod)}</div>
          <div style="font-size:11px;color:#475569;margin-top:4px">100% prihoda</div>
        </div>
        <div class="kpi-card kpi-blue">
          <div style="font-size:11px;color:#64748b;text-transform:uppercase;margin-bottom:8px"><i class="fas fa-building mr-1"></i>Net troškovi</div>
          <div style="font-size:22px;font-weight:700;color:#3b82f6">\${fmtEur(totalNet)}</div>
          <div style="font-size:11px;color:#475569;margin-top:4px">\${totalPrihod>0?fmt(totalNet/totalPrihod*100,1)+'% od prihoda':'—'}</div>
        </div>
        <div class="kpi-card kpi-purple">
          <div style="font-size:11px;color:#64748b;text-transform:uppercase;margin-bottom:8px"><i class="fas fa-layer-group mr-1"></i>Gross marža</div>
          <div style="font-size:22px;font-weight:700;color:#8b5cf6">\${fmtEur(totalGross)}</div>
          <div style="font-size:11px;color:#475569;margin-top:4px">\${totalPrihod>0?fmt(totalGross/totalPrihod*100,1)+'% od prihoda':'—'}</div>
        </div>
        <div class="kpi-card kpi-yellow">
          <div style="font-size:11px;color:#64748b;text-transform:uppercase;margin-bottom:8px"><i class="fas fa-handshake mr-1"></i>Komisije agencijama</div>
          <div style="font-size:22px;font-weight:700;color:#f59e0b">\${fmtEur(totalKom)}</div>
          <div style="font-size:11px;color:#475569;margin-top:4px">\${totalGross>0?fmt(totalKom/totalGross*100,1)+'% od gross':'—'}</div>
        </div>
        <div class="kpi-card" style="background:linear-gradient(135deg,#052e16,#0f172a);border:2px solid #166534;border-radius:12px;padding:20px">
          <div style="font-size:11px;color:#64748b;text-transform:uppercase;margin-bottom:8px"><i class="fas fa-star mr-1" style="color:#10b981"></i>NAŠA MARŽA</div>
          <div style="font-size:24px;font-weight:700;color:#10b981">\${fmtEur(totalNasa)}</div>
          <div style="font-size:11px;color:#475569;margin-top:4px">\${totalGross>0?fmt(totalNasa/totalGross*100,1)+'% od gross':'—'} • \${god.broj_rezervacija||0} rez.</div>
          <div style="margin-top:8px;padding-top:8px;border-top:1px solid #166534">
            <div style="font-size:10px;color:#475569;text-transform:uppercase;letter-spacing:.06em;margin-bottom:2px">Bez PDV (−20%)</div>
            <div style="font-size:20px;font-weight:700;color:#34d399">\${fmtEur(totalNasa * 0.80)}</div>
            <div style="font-size:11px;color:#475569;margin-top:2px">PDV: \${fmtEur(totalNasa * 0.20)}</div>
          </div>
        </div>
      </div>

      <div style="display:grid;grid-template-columns:2fr 1fr;gap:16px;margin-bottom:16px">
        <div class="card">
          <div style="font-weight:600;margin-bottom:4px;font-size:14px;color:#f1f5f9"><i class="fas fa-layer-group mr-2" style="color:#10b981"></i>Raspodela svakog EUR prihoda po mesecima</div>
          <div style="font-size:12px;color:#475569;margin-bottom:14px">Stacked = Net trošak (plavo) + Komisije agencijama (žuto) + Naša marža (zeleno)</div>
          <div class="chart-container" style="height:300px"><canvas id="chart-rasp-stack"></canvas></div>
        </div>
        <div class="card" style="display:flex;flex-direction:column;justify-content:center;align-items:center">
          <div style="font-weight:600;margin-bottom:16px;font-size:14px;color:#f1f5f9;text-align:center">Ukupna raspodela prihoda</div>
          <div class="chart-container" style="height:240px;width:240px"><canvas id="chart-rasp-donut"></canvas></div>
        </div>
      </div>

      <div class="card">
        <div style="font-weight:600;margin-bottom:4px;font-size:14px;color:#f1f5f9">Mesečni detalji raspodele</div>
        <div style="font-size:12px;color:#475569;margin-bottom:12px">Naša marža bez PDV = Naša marža × 0.80 (odbitak 20% PDV)</div>
        <div style="overflow:auto;max-height:320px">
          <table><thead><tr>
            <th>Mesec</th>
            <th>Ukupan prihod</th>
            <th>Net trošak</th>
            <th>Gross marža</th>
            <th style="color:#fcd34d">Komisije agt.</th>
            <th style="color:#6ee7b7">Naša marža</th>
            <th style="color:#34d399">Bez PDV</th>
            <th style="color:#f87171">PDV (20%)</th>
          </tr></thead><tbody>
          \${mesecni.map(r=>{
            const gm = parseFloat(r.gross_marza||0)
            const nm = parseFloat(r.nasa_marza||0)
            const nmBezPdv = nm * 0.80
            const pdvIznos = nm * 0.20
            const nmPct = gm > 0 ? fmt(nm/gm*100,1) : '—'
            return \`<tr>
              <td style="font-weight:600">\${r.mesec}</td>
              <td style="color:#10b981">\${fmtEur(r.ukupan_prihod)}</td>
              <td style="color:#3b82f6">\${fmtEur(r.net_troskovi)}</td>
              <td style="color:#8b5cf6">\${fmtEur(r.gross_marza)}</td>
              <td style="color:#f59e0b;font-weight:600">\${fmtEur(r.komisije_agencijama)}</td>
              <td style="color:#10b981;font-weight:700">\${fmtEur(nm)}</td>
              <td style="color:#34d399;font-weight:700">\${fmtEur(nmBezPdv)}</td>
              <td style="color:#ef4444;font-size:12px">\${fmtEur(pdvIznos)}</td>
            </tr>\`
          }).join('')}
          <tr style="background:#0f172a;font-weight:700;border-top:2px solid #334155">
            <td style="color:#f1f5f9">UKUPNO</td>
            <td style="color:#10b981">\${fmtEur(totalPrihod)}</td>
            <td style="color:#3b82f6">\${fmtEur(totalNet)}</td>
            <td style="color:#8b5cf6">\${fmtEur(totalGross)}</td>
            <td style="color:#f59e0b">\${fmtEur(totalKom)}</td>
            <td style="color:#10b981">\${fmtEur(totalNasa)}</td>
            <td style="color:#34d399">\${fmtEur(totalNasa * 0.80)}</td>
            <td style="color:#ef4444">\${fmtEur(totalNasa * 0.20)}</td>
          </tr>
          </tbody></table>
        </div>
      </div>
    \`
    // Stacked bar
    makeChart('chart-rasp-stack','bar',{
      labels: mesecni.map(r=>r.mesec),
      datasets:[
        { label:'Net trošak', data:mesecni.map(r=>r.net_troskovi||0), backgroundColor:'rgba(59,130,246,0.75)', stack:'s' },
        { label:'Komisije agencijama', data:mesecni.map(r=>r.komisije_agencijama||0), backgroundColor:'rgba(245,158,11,0.85)', stack:'s' },
        { label:'Naša marža', data:mesecni.map(r=>r.nasa_marza||0), backgroundColor:'rgba(16,185,129,0.9)', stack:'s' },
      ]
    },{scales:{
      x:{stacked:true,grid:{color:'#1e293b'},ticks:{color:'#64748b'}},
      y:{stacked:true,grid:{color:'#1e293b'},ticks:{color:'#64748b',callback:v=>'€'+v.toLocaleString()}}
    }})
    // Donut ukupna raspodela
    makeChart('chart-rasp-donut','doughnut',{
      labels:['Net trošak','Komisije agencijama','Naša marža'],
      datasets:[{
        data:[totalNet, totalKom, totalNasa],
        backgroundColor:['rgba(59,130,246,0.85)','rgba(245,158,11,0.85)','rgba(16,185,129,0.9)'],
        borderColor:['#3b82f6','#f59e0b','#10b981'],
        borderWidth:2
      }]
    },{plugins:{legend:{position:'bottom',labels:{color:'#94a3b8',font:{size:11}}}}})
  }

  else if (tab === 'naplate') {
    const naplate = window.finData.naplate || []
    content.innerHTML = \`
      <div class="card" style="margin-bottom:16px">
        <div style="font-weight:600;margin-bottom:16px;font-size:14px;color:#f1f5f9">Naplate po mesecima</div>
        <div class="chart-container" style="height:300px"><canvas id="chart-fin-naplate"></canvas></div>
      </div>
      <div class="card">
        <div style="overflow:auto;max-height:300px">
          <table><thead><tr><th>Mesec</th><th>Naplaćeno (EUR)</th><th>Naplaćeno (RSD)</th><th>Broj uplata</th></tr></thead>
          <tbody>\${naplate.map(r=>\`<tr>
            <td>\${r.mesec}</td>
            <td style="color:#10b981;font-weight:600">\${fmtEur(r.naplaceno_eur)}</td>
            <td>\${fmtRsd(r.naplaceno_rsd)}</td>
            <td>\${fmtInt(r.broj_uplata)}</td>
          </tr>\`).join('')}</tbody></table>
        </div>
      </div>
    \`
    makeChart('chart-fin-naplate', 'line', {
      labels: naplate.map(r=>r.mesec),
      datasets: [
        { label:'EUR', data:naplate.map(r=>r.naplaceno_eur), borderColor:'#10b981', backgroundColor:'rgba(16,185,129,.1)', fill:true, tension:.4, yAxisID:'y' },
        { label:'RSD (÷100)', data:naplate.map(r=>(r.naplaceno_rsd/100).toFixed(0)), borderColor:'#3b82f6', backgroundColor:'rgba(59,130,246,.1)', fill:true, tension:.4, yAxisID:'y1' }
      ]
    }, { scales: {
      x:{grid:{color:'#1e293b'},ticks:{color:'#64748b'}},
      y:{grid:{color:'#1e293b'},ticks:{color:'#64748b',callback:v=>'€'+v}},
      y1:{position:'right',grid:{drawOnChartArea:false},ticks:{color:'#3b82f6'}}
    }})
  }

  else if (tab === 'obroci') {
    const rows = (await axios.get(\`/api/finansije/obroci?status=pending\`)).data
    content.innerHTML = \`
      <div class="card">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;flex-wrap:wrap;gap:8px">
          <div style="font-weight:600;font-size:14px;color:#f1f5f9"><i class="fas fa-calendar-alt mr-2" style="color:#f59e0b"></i>Obroci plaćanja na čekanju</div>
          <span class="badge badge-yellow">\${rows.length} obroka</span>
        </div>
        <div style="overflow:auto;max-height:500px">
          <table><thead><tr>
            <th>Dospeće</th><th>Rezervacija</th><th>Agencija</th><th>Hotel</th><th>Check-in</th><th>Iznos</th><th>Procenat</th>
          </tr></thead><tbody>
          \${rows.map(r=>\`<tr>
            <td style="color:\${new Date(r.due_at)<new Date()?'#ef4444':'#f59e0b'};font-weight:600">\${r.due_at||'—'}</td>
            <td><code style="font-size:11px;color:#60a5fa">\${r.reference}</code></td>
            <td>\${r.agencija||'—'}</td>
            <td style="font-size:12px">\${r.hotel_name||'—'}</td>
            <td>\${r.checkin||'—'}</td>
            <td style="font-weight:600;color:#f59e0b">\${r.currency==='EUR'?fmtEur(r.amount):fmtRsd(r.amount)}</td>
            <td>\${r.percentage}%</td>
          </tr>\`).join('')}
          </tbody></table>
        </div>
      </div>
    \`
  }

  else if (tab === 'bankovni') {
    const data = (await axios.get(\`/api/finansije/bankovni-izvodi?\${dateParams()}\`)).data
    const izvodi = data.izvodi || []
    const stats = data.stats || {}
    content.innerHTML = \`
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:12px;margin-bottom:16px">
        <div class="kpi-card kpi-green"><div style="font-size:11px;color:#64748b;margin-bottom:6px">Ukupno primljeno (RSD)</div><div style="font-size:20px;font-weight:700;color:#10b981">\${fmtRsd(stats.ukupno_rsd)}</div></div>
        <div class="kpi-card kpi-blue"><div style="font-size:11px;color:#64748b;margin-bottom:6px">Stavki ukupno</div><div style="font-size:20px;font-weight:700;color:#3b82f6">\${fmtInt(stats.broj_stavki)}</div></div>
        <div class="kpi-card kpi-green"><div style="font-size:11px;color:#64748b;margin-bottom:6px">Upareno sa rez.</div><div style="font-size:20px;font-weight:700;color:#10b981">\${fmtInt(stats.matched)}</div></div>
        <div class="kpi-card kpi-red"><div style="font-size:11px;color:#64748b;margin-bottom:6px">Nije upareno</div><div style="font-size:20px;font-weight:700;color:#ef4444">\${fmtInt(stats.unmatched)}</div></div>
      </div>
      <div class="card">
        <div style="overflow:auto;max-height:400px">
          <table><thead><tr>
            <th>Datum</th><th>Broj izvoda</th><th>Partija</th><th>Preth. stanje</th><th>Novo stanje</th><th>Potražni promet</th>
          </tr></thead><tbody>
          \${izvodi.map(i=>\`<tr>
            <td>\${i.datum_izvoda}</td>
            <td><code style="font-size:11px;color:#60a5fa">\${i.broj_izvoda||'—'}</code></td>
            <td style="font-size:12px;color:#94a3b8">\${i.partija||'—'}</td>
            <td>\${fmtRsd(i.prethodno_stanje)}</td>
            <td style="font-weight:600;color:#10b981">\${fmtRsd(i.novo_stanje)}</td>
            <td style="color:#3b82f6">\${fmtRsd(i.potrazni_promet)}</td>
          </tr>\`).join('')}
          </tbody></table>
        </div>
      </div>
    \`
  }

  else if (tab === 'kurs') {
    const rows = (await axios.get('/api/finansije/kurs')).data
    content.innerHTML = \`
      <div class="card" style="margin-bottom:16px">
        <div style="font-weight:600;margin-bottom:16px;font-size:14px;color:#f1f5f9">EUR/RSD kursna lista (poslednja 90 dana)</div>
        <div class="chart-container" style="height:280px"><canvas id="chart-fin-kurs"></canvas></div>
      </div>
      <div class="card"><div style="overflow:auto;max-height:300px">
        <table><thead><tr><th>Datum</th><th>Kurs (EUR/RSD)</th></tr></thead>
        <tbody>\${rows.map(r=>\`<tr><td>\${r.date}</td><td style="font-weight:600;color:#f59e0b">\${fmt(r.value,4)}</td></tr>\`).join('')}
        </tbody></table>
      </div></div>
    \`
    const sorted = [...rows].sort((a,b)=>a.date.localeCompare(b.date))
    makeChart('chart-fin-kurs','line',{
      labels: sorted.map(r=>r.date),
      datasets:[{label:'EUR/RSD',data:sorted.map(r=>r.value),borderColor:'#f59e0b',backgroundColor:'rgba(245,158,11,.1)',fill:true,tension:.3,pointRadius:2}]
    })
  }
}

// ═══════════════════════════════════════════
// REZERVACIJE TABOVI
// ═══════════════════════════════════════════
async function rezTab(tab, btn) {
  document.querySelectorAll('#module-content .tab').forEach(t=>t.classList.remove('active'))
  btn.classList.add('active')
  const content = document.getElementById('rez-content')
  destroyCharts()

  if (tab === 'trend') {
    const d = window.rezData
    const trend = d.trend || []
    content.innerHTML = \`
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:16px">
        <div class="card">
          <div style="font-weight:600;margin-bottom:16px;font-size:14px;color:#f1f5f9">Broj rezervacija po mesecima</div>
          <div class="chart-container" style="height:260px"><canvas id="chart-rez-trend"></canvas></div>
        </div>
        <div class="card">
          <div style="font-weight:600;margin-bottom:16px;font-size:14px;color:#f1f5f9">Prihod po mesecima (EUR)</div>
          <div class="chart-container" style="height:260px"><canvas id="chart-rez-prihod"></canvas></div>
        </div>
      </div>
      <div class="card">
        <div style="font-weight:600;margin-bottom:12px;font-size:14px;color:#f1f5f9">Načini plaćanja</div>
        <div id="nacin-tabela"></div>
      </div>
    \`
    makeChart('chart-rez-trend','bar',{
      labels:trend.map(r=>r.mesec),
      datasets:[
        {label:'Prihvaćene',data:trend.map(r=>r.prihvacene),backgroundColor:'#10b981'},
        {label:'Odbijene',data:trend.map(r=>r.odbijene),backgroundColor:'#ef4444'},
        {label:'Otkazane',data:trend.map(r=>r.otkazane),backgroundColor:'#f59e0b'},
      ]
    },{scales:{x:{stacked:true,grid:{color:'#1e293b'},ticks:{color:'#64748b'}},y:{stacked:true,grid:{color:'#1e293b'},ticks:{color:'#64748b'}}}})
    makeChart('chart-rez-prihod','line',{
      labels:trend.map(r=>r.mesec),
      datasets:[{label:'Prihod (EUR)',data:trend.map(r=>r.prihod),borderColor:'#3b82f6',backgroundColor:'rgba(59,130,246,.1)',fill:true,tension:.4}]
    })
    const nacin = d.nacin_placanja || []
    document.getElementById('nacin-tabela').innerHTML = \`
      <table><thead><tr><th>Način plaćanja</th><th>Broj</th><th>Vrednost (EUR)</th></tr></thead>
      <tbody>\${nacin.map(r=>\`<tr><td>\${r.nacin}</td><td>\${fmtInt(r.cnt)}</td><td style="color:#3b82f6">\${fmtEur(r.vrednost)}</td></tr>\`).join('')}
      </tbody></table>
    \`
  }

  else if (tab === 'statusi') {
    const d = window.rezData
    const statusi = d.statusi || []
    const plat = d.platni_status || []
    const ukupnoRez = statusi.reduce((a,r)=>a+parseInt(r.cnt||0),0)
    const ukupnoVred = statusi.reduce((a,r)=>a+parseFloat(r.vrednost||0),0)

    const STATUS_COLORS = {
      accepted: '#10b981', rejected: '#ef4444', pending: '#f59e0b',
      none: '#64748b', cancelled_refund: '#f97316', cancelled_transfer: '#fb923c',
      cancelled_penalty: '#dc2626', overpayment: '#3b82f6'
    }

    content.innerHTML = \`
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:10px;margin-bottom:16px">
        \${statusi.map(r=>{
          const col = STATUS_COLORS[r.status]||'#64748b'
          const pct = ukupnoRez>0?(parseInt(r.cnt)/ukupnoRez*100).toFixed(1):0
          return \`<div onclick="loadStatusTable('\${r.status}',this)"
            style="background:#0f172a;border:2px solid \${col}33;border-radius:10px;padding:12px;cursor:pointer;transition:all .2s"
            class="status-filter-card" data-status="\${r.status}">
            <div style="font-size:11px;color:#64748b;margin-bottom:4px">\${STATUS_LABELS[r.status]||r.status}</div>
            <div style="font-size:22px;font-weight:700;color:\${col}">\${fmtInt(r.cnt)}</div>
            <div style="font-size:11px;color:#475569;margin-top:2px">\${fmtEur(r.vrednost)}</div>
            <div style="margin-top:6px;height:3px;background:#1e293b;border-radius:2px">
              <div style="height:100%;width:\${pct}%;background:\${col};border-radius:2px;transition:width .6s"></div>
            </div>
            <div style="font-size:10px;color:#475569;margin-top:3px">\${pct}% rezervacija</div>
          </div>\`
        }).join('')}
      </div>

      <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:16px">
        <div class="card">
          <div style="font-weight:600;margin-bottom:16px;font-size:14px;color:#f1f5f9">Broj rezervacija po statusu</div>
          <div class="chart-container" style="height:240px"><canvas id="chart-rez-status"></canvas></div>
        </div>
        <div class="card">
          <div style="font-weight:600;margin-bottom:16px;font-size:14px;color:#f1f5f9">Vrednost po statusu (EUR)</div>
          <div class="chart-container" style="height:240px"><canvas id="chart-rez-status-vred"></canvas></div>
        </div>
      </div>

      <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:16px">
        <div class="card">
          <div style="font-weight:600;margin-bottom:16px;font-size:14px;color:#f1f5f9">Platni status — broj</div>
          <div class="chart-container" style="height:220px"><canvas id="chart-rez-pay"></canvas></div>
        </div>
        <div class="card">
          <div style="font-weight:600;margin-bottom:16px;font-size:14px;color:#f1f5f9">Platni status — vrednost (EUR)</div>
          <div class="chart-container" style="height:220px"><canvas id="chart-rez-pay-vred"></canvas></div>
        </div>
      </div>

      <div class="card" id="status-table-card" style="display:none">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;flex-wrap:wrap;gap:8px">
          <div>
            <div style="font-weight:600;font-size:14px;color:#f1f5f9" id="status-table-title">Rezervacije</div>
            <div style="font-size:12px;color:#64748b;margin-top:2px" id="status-table-sub"></div>
          </div>
          <div style="display:flex;gap:8px;align-items:center">
            <input type="text" id="status-search" placeholder="Pretraži..." oninput="filterTable(this,'status-tbody')"
              style="background:#0f172a;border:1px solid #334155;color:#e2e8f0;border-radius:8px;padding:6px 12px;font-size:13px;outline:none;width:200px">
            <button class="btn btn-ghost" onclick="closeStatusTable()" style="font-size:12px">
              <i class="fas fa-times"></i> Zatvori
            </button>
          </div>
        </div>
        <div style="overflow:auto;max-height:480px">
          <table><thead><tr>
            <th>Reference</th>
            <th>Agencija</th>
            <th>Hotel</th>
            <th>Check-in</th>
            <th>Noć.</th>
            <th>Cena (EUR)</th>
            <th>Net (EUR)</th>
            <th>Platni status</th>
            <th>Način plaćanja</th>
            <th>Datum</th>
          </tr></thead>
          <tbody id="status-tbody"></tbody></table>
        </div>
        <div style="display:flex;align-items:center;justify-content:space-between;margin-top:12px;flex-wrap:wrap;gap:8px">
          <div id="status-pagination-info" style="font-size:12px;color:#64748b"></div>
          <div style="display:flex;gap:6px">
            <button class="btn btn-ghost" id="btn-prev-page" onclick="statusPage(-1)" style="font-size:12px">
              <i class="fas fa-chevron-left"></i> Prethodna
            </button>
            <button class="btn btn-ghost" id="btn-next-page" onclick="statusPage(1)" style="font-size:12px">
              Sledeća <i class="fas fa-chevron-right"></i>
            </button>
          </div>
        </div>
      </div>
    \`

    makeChart('chart-rez-status','doughnut',{
      labels:statusi.map(r=>STATUS_LABELS[r.status]||r.status),
      datasets:[{data:statusi.map(r=>r.cnt),backgroundColor:statusi.map(r=>STATUS_COLORS[r.status]||'#64748b')}]
    },{plugins:{legend:{position:'right',labels:{color:'#94a3b8',font:{size:11}}}}})

    makeChart('chart-rez-status-vred','doughnut',{
      labels:statusi.map(r=>STATUS_LABELS[r.status]||r.status),
      datasets:[{data:statusi.map(r=>parseFloat(r.vrednost||0).toFixed(2)),backgroundColor:statusi.map(r=>STATUS_COLORS[r.status]||'#64748b')}]
    },{plugins:{legend:{position:'right',labels:{color:'#94a3b8',font:{size:11}}},tooltip:{callbacks:{label:ctx=>' € '+parseFloat(ctx.raw).toLocaleString('sr-RS',{minimumFractionDigits:2})}}}})

    const PAY_COLORS = ['#10b981','#f59e0b','#64748b','#3b82f6','#8b5cf6']
    makeChart('chart-rez-pay','doughnut',{
      labels:plat.map(r=>PAY_LABELS[r.payment_status]||r.payment_status),
      datasets:[{data:plat.map(r=>r.cnt),backgroundColor:PAY_COLORS}]
    },{plugins:{legend:{position:'right',labels:{color:'#94a3b8',font:{size:11}}}}})

    makeChart('chart-rez-pay-vred','doughnut',{
      labels:plat.map(r=>PAY_LABELS[r.payment_status]||r.payment_status),
      datasets:[{data:plat.map(r=>parseFloat(r.vrednost||0).toFixed(2)),backgroundColor:PAY_COLORS}]
    },{plugins:{legend:{position:'right',labels:{color:'#94a3b8',font:{size:11}}},tooltip:{callbacks:{label:ctx=>' € '+parseFloat(ctx.raw).toLocaleString('sr-RS',{minimumFractionDigits:2})}}}})
  }

  else if (tab === 'nocenja') {
    const d = window.rezData
    const nocenja = d.nocenja || []
    content.innerHTML = \`
      <div class="card">
        <div style="font-weight:600;margin-bottom:16px;font-size:14px;color:#f1f5f9">Distribucija broja noćenja</div>
        <div class="chart-container" style="height:300px"><canvas id="chart-rez-nocenja"></canvas></div>
      </div>
    \`
    makeChart('chart-rez-nocenja','bar',{
      labels:nocenja.map(r=>r.nights+' noć.'),
      datasets:[
        {label:'Broj rezervacija',data:nocenja.map(r=>r.cnt),backgroundColor:'#3b82f6',yAxisID:'y'},
        {label:'Avg. cena (EUR)',data:nocenja.map(r=>parseFloat(r.avg_cena||0).toFixed(2)),borderColor:'#f59e0b',type:'line',yAxisID:'y1',tension:.4}
      ]
    },{scales:{
      x:{grid:{color:'#1e293b'},ticks:{color:'#64748b'}},
      y:{grid:{color:'#1e293b'},ticks:{color:'#64748b'}},
      y1:{position:'right',grid:{drawOnChartArea:false},ticks:{color:'#f59e0b',callback:v=>'€'+v}}
    }})
  }

  else if (tab === 'otkazivanja') {
    const rows = (await axios.get(\`/api/rezervacije/otkazivanja?\${dateParams()}\`)).data
    content.innerHTML = \`
      <div class="card">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;flex-wrap:wrap;gap:8px">
          <div style="font-weight:600;font-size:14px;color:#f1f5f9"><i class="fas fa-ban mr-2" style="color:#ef4444"></i>Otkazivanja rezervacija</div>
          <span class="badge badge-red">\${rows.length} otkazivanja</span>
        </div>
        <div style="overflow:auto;max-height:500px">
          <table><thead><tr>
            <th>Datum</th><th>Rezervacija</th><th>Agencija</th><th>Hotel</th><th>Check-in</th>
            <th>Ukupan trošak</th><th>Provajder</th><th>Agencija</th><th>Refund</th><th>Isplaćeno</th>
          </tr></thead><tbody>
          \${rows.map(r=>\`<tr>
            <td>\${r.cancelled_at?.split('T')[0]||'—'}</td>
            <td><code style="font-size:11px;color:#60a5fa">\${r.reference}</code></td>
            <td style="font-size:12px">\${r.agencija||'—'}</td>
            <td style="font-size:12px">\${r.hotel_name||'—'}</td>
            <td>\${r.checkin||'—'}</td>
            <td style="color:#ef4444;font-weight:600">\${fmtEur(r.total_cost)}</td>
            <td style="color:#f59e0b">\${fmtEur(r.provider_amount)}</td>
            <td style="color:#8b5cf6">\${fmtEur(r.agency_amount)}</td>
            <td style="color:#10b981">\${fmtEur(r.refund_amount)}</td>
            <td>\${r.paid_out?'<span class="badge badge-green">Da</span>':'<span class="badge badge-red">Ne</span>'}</td>
          </tr>\`).join('')}
          </tbody></table>
        </div>
      </div>
    \`
  }

  else if (tab === 'checkin') {
    const rows = (await axios.get(\`/api/rezervacije/checkin-kalendar?\${dateParams()}\`)).data
    content.innerHTML = \`
      <div class="card">
        <div style="font-weight:600;margin-bottom:16px;font-size:14px;color:#f1f5f9">Dolasci (Check-in) po mesecima</div>
        <div class="chart-container" style="height:300px"><canvas id="chart-rez-checkin"></canvas></div>
      </div>
    \`
    makeChart('chart-rez-checkin','bar',{
      labels:rows.map(r=>r.mesec),
      datasets:[
        {label:'Broj dolazaka',data:rows.map(r=>r.dolasci),backgroundColor:'#10b981',yAxisID:'y'},
        {label:'Noćenja',data:rows.map(r=>r.nocenja),backgroundColor:'#3b82f6',yAxisID:'y'},
        {label:'Vrednost (EUR)',data:rows.map(r=>r.vrednost),borderColor:'#f59e0b',type:'line',yAxisID:'y1',tension:.4}
      ]
    },{scales:{
      x:{grid:{color:'#1e293b'},ticks:{color:'#64748b'}},
      y:{grid:{color:'#1e293b'},ticks:{color:'#64748b'}},
      y1:{position:'right',grid:{drawOnChartArea:false},ticks:{color:'#f59e0b',callback:v=>'€'+v}}
    }})
  }
}

// ═══════════════════════════════════════════
// AGENCIJE TABOVI
// ═══════════════════════════════════════════
function agtTab(tab, btn) {
  document.querySelectorAll('#module-content .tab').forEach(t=>t.classList.remove('active'))
  btn.classList.add('active')
  const content = document.getElementById('agt-content')
  destroyCharts()
  const d = window.agtData

  if (tab === 'rang') {
    window.rangData = d.rang || []
    window.rangSort = { col: 'prihod', dir: -1 }
    renderRangTabela()
  }

  else if (tab === 'grafikon') {
    const top15 = (d.rang||[]).slice(0,15)
    content.innerHTML = \`
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:16px">
        <div class="card">
          <div style="font-weight:600;margin-bottom:16px;font-size:14px;color:#f1f5f9">Top 15 agencija — Prihod (EUR)</div>
          <div class="chart-container" style="height:420px"><canvas id="chart-agt-prihod"></canvas></div>
        </div>
        <div class="card">
          <div style="font-weight:600;margin-bottom:16px;font-size:14px;color:#f1f5f9">Top 15 agencija — Rezervacije</div>
          <div class="chart-container" style="height:420px"><canvas id="chart-agt-rez"></canvas></div>
        </div>
      </div>
      <div class="card">
        <div style="font-weight:600;margin-bottom:4px;font-size:14px;color:#f1f5f9"><i class="fas fa-layer-group mr-2" style="color:#10b981"></i>Naša marža vs Komisije agencijama — Top 15</div>
        <div style="font-size:12px;color:#475569;margin-bottom:14px">Stacked bar: zeleno = naša marža, žuto = komisije agencijama</div>
        <div class="chart-container" style="height:380px"><canvas id="chart-agt-marza-stack"></canvas></div>
      </div>
    \`
    const labels15 = top15.map(r=>r.name.length>22?r.name.substring(0,22)+'…':r.name)
    makeChart('chart-agt-prihod','bar',{
      labels:labels15,
      datasets:[{label:'Prihod (EUR)',data:top15.map(r=>r.prihod),backgroundColor:COLORS}]
    },{indexAxis:'y'})
    makeChart('chart-agt-rez','bar',{
      labels:labels15,
      datasets:[{label:'Rezervacije',data:top15.map(r=>r.rezervacije),backgroundColor:'#3b82f6'}]
    },{indexAxis:'y'})
    makeChart('chart-agt-marza-stack','bar',{
      labels:labels15,
      datasets:[
        { label:'Naša marža', data:top15.map(r=>r.nasa_marza||0), backgroundColor:'rgba(16,185,129,0.85)', stack:'s' },
        { label:'Komisije agencijama', data:top15.map(r=>r.komisija_agenciji||0), backgroundColor:'rgba(245,158,11,0.85)', stack:'s' },
      ]
    },{indexAxis:'y', scales:{
      x:{stacked:true,grid:{color:'#1e293b'},ticks:{color:'#64748b',callback:v=>'€'+v.toLocaleString()}},
      y:{stacked:true,grid:{color:'#1e293b'},ticks:{color:'#64748b'}}
    }})
  }

  else if (tab === 'tabela') {
    const lista = d.lista || []
    content.innerHTML = \`
      <div class="card">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;flex-wrap:wrap;gap:8px">
          <div style="font-weight:600;font-size:14px;color:#f1f5f9">Sve agencije</div>
          <input type="text" id="agt-search" placeholder="Pretraži agencije..." oninput="filterTable(this,'agt-tbody')"
            style="background:#0f172a;border:1px solid #334155;color:#e2e8f0;border-radius:8px;padding:6px 12px;font-size:13px;outline:none;width:220px">
        </div>
        <div style="overflow:auto;max-height:500px">
          <table><thead><tr>
            <th>Agencija</th><th>Status</th><th>Rez.</th>
            <th>Prihvaćene</th><th>Ukupan prihod</th>
            <th>Gross marža</th><th style="color:#fcd34d">Komisija agt.</th>
            <th style="color:#6ee7b7">Naša marža</th>
            <th style="color:#34d399">Bez PDV</th>
            <th>Prosečna vred.</th><th>Poslednja rez.</th>
          </tr></thead><tbody id="agt-tbody">
          \${lista.map(u=>{
            const nm = parseFloat(u.nasa_marza||0)
            return \`<tr>
            <td style="font-weight:600">\${u.name}</td>
            <td>\${u.is_active?'<span class="badge badge-green">Aktivan</span>':'<span class="badge badge-gray">Neaktivan</span>'}</td>
            <td>\${fmtInt(u.broj_rezervacija)}</td>
            <td style="color:#10b981">\${fmtInt(u.prihvacene)}</td>
            <td style="color:#10b981;font-weight:600">\${fmtEur(u.ukupan_prihod)}</td>
            <td style="color:#8b5cf6">\${fmtEur(u.gross_marza)}</td>
            <td style="color:#f59e0b;font-weight:600">\${fmtEur(u.komisija_agenciji)}</td>
            <td style="color:#10b981;font-weight:700">\${fmtEur(nm)}</td>
            <td style="color:#34d399;font-weight:700">\${fmtEur(nm * 0.80)}</td>
            <td style="color:#64748b">\${fmtEur(u.prosecna_vrednost)}</td>
            <td style="font-size:12px;color:#64748b">\${u.poslednja_rezervacija?.split('T')[0]||'—'}</td>
          </tr>\`}).join('')}
          </tbody></table>
        </div>
      </div>
    \`
  }
}

// ═══════════════════════════════════════════
// PROVAJDERI TABOVI
// ═══════════════════════════════════════════
async function prvTab(tab, btn) {
  document.querySelectorAll('#module-content .tab').forEach(t=>t.classList.remove('active'))
  btn.classList.add('active')
  const content = document.getElementById('prv-content')
  destroyCharts()
  const d = window.prvData

  if (tab === 'pregled') {
    const lista = d.lista || []
    const topPrv = lista.filter(p=>p.prihod_eur>0).slice(0,10)
    content.innerHTML = \`
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:16px">
        <div class="card">
          <div style="font-weight:600;margin-bottom:16px;font-size:14px;color:#f1f5f9">Top provajderi — Prihod (EUR)</div>
          <div class="chart-container" style="height:300px"><canvas id="chart-prv-bar"></canvas></div>
        </div>
        <div class="card">
          <div style="font-weight:600;margin-bottom:16px;font-size:14px;color:#f1f5f9">Udeo u rezervacijama</div>
          <div class="chart-container" style="height:300px"><canvas id="chart-prv-pie"></canvas></div>
        </div>
      </div>
      <div class="card">
        <div style="overflow:auto;max-height:400px">
          <table><thead><tr>
            <th>Provajder</th><th>Status</th><th>Markup %</th><th>Rezervacije</th>
            <th>Prihod (EUR)</th><th>Net (EUR)</th><th>Marža (EUR)</th>
          </tr></thead><tbody>
          \${lista.map(p=>\`<tr>
            <td style="font-weight:600">\${p.name}</td>
            <td>\${p.enabled?'<span class="badge badge-green">Aktivan</span>':'<span class="badge badge-gray">Neaktivan</span>'}</td>
            <td>\${p.markup_percent||'—'}%</td>
            <td>\${fmtInt(p.rezervacije)}</td>
            <td style="color:#10b981;font-weight:600">\${fmtEur(p.prihod_eur)}</td>
            <td>\${fmtEur(p.net_eur)}</td>
            <td style="color:#8b5cf6">\${fmtEur(p.marza_eur)}</td>
          </tr>\`).join('')}
          </tbody></table>
        </div>
      </div>
    \`
    makeChart('chart-prv-bar','bar',{
      labels:topPrv.map(p=>p.name.length>18?p.name.substring(0,18)+'…':p.name),
      datasets:[
        {label:'Prihod',data:topPrv.map(p=>p.prihod_eur),backgroundColor:'#3b82f6'},
        {label:'Net',data:topPrv.map(p=>p.net_eur),backgroundColor:'#10b981'},
      ]
    },{indexAxis:'y'})
    makeChart('chart-prv-pie','doughnut',{
      labels:topPrv.map(p=>p.name.length>18?p.name.substring(0,18)+'…':p.name),
      datasets:[{data:topPrv.map(p=>p.rezervacije),backgroundColor:COLORS}]
    },{plugins:{legend:{position:'right',labels:{color:'#94a3b8',font:{size:10}}}}})
  }

  else if (tab === 'fakture') {
    const dugovanja = d.fakture.dugovanja || []
    const fakture = d.fakture.fakture || []
    content.innerHTML = \`
      <div style="margin-bottom:16px">
        <div style="font-weight:600;margin-bottom:12px;font-size:14px;color:#f1f5f9">Dugovanja prema provajderima</div>
        <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:12px" id="dug-kpi"></div>
      </div>
      <div class="card">
        <div style="font-weight:600;margin-bottom:16px;font-size:14px;color:#f1f5f9">Fakture</div>
        <div style="overflow:auto;max-height:400px">
          <table><thead><tr>
            <th>Provajder</th><th>Broj fakture</th><th>Iznos</th><th>Plaćeno</th><th>Ostatak</th>
            <th>Datum izdavanja</th><th>Dospeće</th>
          </tr></thead><tbody>
          \${fakture.map(f=>\`<tr>
            <td style="font-weight:600">\${f.provajder}</td>
            <td><code style="font-size:11px;color:#60a5fa">\${f.invoice_number||'—'}</code></td>
            <td>\${f.currency==='EUR'?fmtEur(f.amount):fmtRsd(f.amount)}</td>
            <td style="color:#10b981">\${f.currency==='EUR'?fmtEur(f.placeno):fmtRsd(f.placeno)}</td>
            <td style="color:\${f.ostatak>0?'#ef4444':'#10b981'};font-weight:600">\${f.currency==='EUR'?fmtEur(f.ostatak):fmtRsd(f.ostatak)}</td>
            <td>\${f.issued_at||'—'}</td>
            <td style="color:\${f.due_at&&new Date(f.due_at)<new Date()?'#ef4444':'#f59e0b'}">\${f.due_at||'—'}</td>
          </tr>\`).join('')}
          </tbody></table>
        </div>
      </div>
    \`
    const kpiEl = document.getElementById('dug-kpi')
    dugovanja.forEach((d,i)=>{
      kpiEl.innerHTML += \`
        <div style="background:#0f172a;border:1px solid #334155;border-radius:10px;padding:14px">
          <div style="font-size:12px;font-weight:600;color:#f1f5f9;margin-bottom:8px">\${d.provajder}</div>
          <div style="display:flex;justify-content:space-between;font-size:12px;color:#64748b;margin-bottom:4px"><span>Fakturisano:</span><span style="color:#94a3b8">\${d.currency==='EUR'?fmtEur(d.ukupno_fakturisano):fmtRsd(d.ukupno_fakturisano)}</span></div>
          <div style="display:flex;justify-content:space-between;font-size:12px;color:#64748b;margin-bottom:4px"><span>Plaćeno:</span><span style="color:#10b981">\${d.currency==='EUR'?fmtEur(d.ukupno_placeno):fmtRsd(d.ukupno_placeno)}</span></div>
          <div style="display:flex;justify-content:space-between;font-size:13px;font-weight:700;margin-top:6px;padding-top:6px;border-top:1px solid #334155"><span style="color:#64748b">Duguje:</span><span style="color:\${d.duguje>0?'#ef4444':'#10b981'}">\${d.currency==='EUR'?fmtEur(d.duguje):fmtRsd(d.duguje)}</span></div>
        </div>
      \`
    })
  }

  else if (tab === 'trend') {
    const rows = (await axios.get(\`/api/provajderi/trend?\${dateParams()}\`)).data
    content.innerHTML = \`
      <div class="card">
        <div style="font-weight:600;margin-bottom:16px;font-size:14px;color:#f1f5f9">Trend rezervacija po provajderima (top 6)</div>
        <div class="chart-container" style="height:340px"><canvas id="chart-prv-trend"></canvas></div>
      </div>
    \`
    const meseci = [...new Set(rows.map(r=>r.mesec))].sort()
    const provSet = [...new Set(rows.map(r=>r.provajder))]
    makeChart('chart-prv-trend','line',{
      labels:meseci,
      datasets:provSet.map((prov,i)=>({
        label:prov,
        data:meseci.map(m=>{const r=rows.find(x=>x.mesec===m&&x.provajder===prov);return r?.rezervacije||0}),
        borderColor:COLORS[i],backgroundColor:COLORS[i]+'22',fill:false,tension:.4
      }))
    })
  }
}

// ═══════════════════════════════════════════
// POMOĆNE FUNKCIJE
// ═══════════════════════════════════════════
function filterTable(input, tbodyId) {
  const val = input.value.toLowerCase()
  document.querySelectorAll('#'+tbodyId+' tr').forEach(tr => {
    tr.style.display = tr.textContent.toLowerCase().includes(val) ? '' : 'none'
  })
}

// ═══════════════════════════════════════════
// AGENCIJE RANG — SORTABILNA TABELA
// ═══════════════════════════════════════════
const RANG_COLS = [
  { key: '_rank',             label: '#',             style: '' },
  { key: 'name',              label: 'Agencija',      style: '' },
  { key: 'rezervacije',       label: 'Rez.',          style: '' },
  { key: 'prihod',            label: 'Prihod (EUR)',  style: 'color:#10b981' },
  { key: 'gross_marza',       label: 'Gross marža',   style: 'color:#8b5cf6' },
  { key: 'komisija_agenciji', label: 'Komisija agt.', style: 'color:#fcd34d' },
  { key: 'nasa_marza',        label: 'Naša marža',    style: 'color:#6ee7b7' },
  { key: '_bez_pdv',          label: 'Bez PDV',       style: 'color:#34d399' },
  { key: 'avg_nocenja',       label: 'Avg. noć.',     style: '' },
  { key: 'stopa_otkazivanja', label: 'Stopa otk. %', style: '' },
]

function sortRang(colKey) {
  const s = window.rangSort
  if (s.col === colKey) {
    s.dir *= -1
  } else {
    s.col = colKey
    s.dir = colKey === 'name' ? 1 : -1
  }
  renderRangTabela()
}

function renderRangTabela() {
  const rang = [...(window.rangData || [])]
  const { col, dir } = window.rangSort

  rang.sort((a, b) => {
    let av, bv
    if (col === '_rank' || col === '_bez_pdv') {
      av = parseFloat(a.nasa_marza || 0) * (col === '_bez_pdv' ? 0.80 : 1)
      bv = parseFloat(b.nasa_marza || 0) * (col === '_bez_pdv' ? 0.80 : 1)
    } else if (col === 'name') {
      return dir * (a.name || '').localeCompare(b.name || '', 'sr')
    } else {
      av = parseFloat(a[col] || 0)
      bv = parseFloat(b[col] || 0)
    }
    return dir * (av - bv)
  })

  const thStyle = (key) => {
    const active = window.rangSort.col === key
    const col = RANG_COLS.find(c => c.key === key)
    return \`cursor:pointer;user-select:none;white-space:nowrap;
      \${col?.style || ''}
      \${active ? 'color:#3b82f6 !important;' : ''}
      transition:color .15s\`
  }

  const arrow = (key) => {
    if (window.rangSort.col !== key) return '<span style="color:#334155;margin-left:4px">⇅</span>'
    return window.rangSort.dir === 1
      ? '<span style="color:#3b82f6;margin-left:4px">↑</span>'
      : '<span style="color:#3b82f6;margin-left:4px">↓</span>'
  }

  const content = document.getElementById('agt-content')
  content.innerHTML = \`
    <div class="card">
      <div style="font-size:12px;color:#475569;margin-bottom:12px;padding:8px 12px;background:#0f172a;border-radius:8px;border:1px solid #1e3a5f">
        <i class="fas fa-info-circle mr-1" style="color:#3b82f6"></i>
        <strong style="color:#93c5fd">Gross marža</strong> = Prihod − Net trošak &nbsp;|&nbsp;
        <strong style="color:#fcd34d">Komisija agenciji</strong> = Prihod × % (ili fiksni iznos) &nbsp;|&nbsp;
        <strong style="color:#6ee7b7">Naša marža</strong> = Gross − Komisija &nbsp;|&nbsp;
        <strong style="color:#34d399">Bez PDV</strong> = Naša marža × 0.80 &nbsp;|&nbsp;
        <i class="fas fa-info-circle mr-1" style="color:#475569"></i><span style="color:#475569">Klikni na header kolone za sortiranje</span>
      </div>
      <div style="overflow:auto;max-height:600px">
        <table><thead><tr>
          \${RANG_COLS.map(c => \`<th onclick="sortRang('\${c.key}')" style="\${thStyle(c.key)}">\${c.label}\${arrow(c.key)}</th>\`).join('')}
        </tr></thead><tbody>
        \${rang.map((r, i) => {
          const nm = parseFloat(r.nasa_marza || 0)
          const stopa = parseFloat(r.stopa_otkazivanja || 0)
          const stopaColor = stopa > 20 ? '#ef4444' : stopa > 10 ? '#f59e0b' : '#10b981'
          return \`<tr>
            <td style="color:#64748b;font-weight:600">\${i + 1}</td>
            <td style="font-weight:600;color:#f1f5f9">\${r.name}</td>
            <td>\${fmtInt(r.rezervacije)}</td>
            <td style="color:#10b981;font-weight:600">\${fmtEur(r.prihod)}</td>
            <td style="color:#8b5cf6">\${fmtEur(r.gross_marza)}</td>
            <td style="color:#f59e0b;font-weight:600">\${fmtEur(r.komisija_agenciji)}</td>
            <td style="color:#10b981;font-weight:700">\${fmtEur(nm)}</td>
            <td style="color:#34d399;font-weight:700">\${fmtEur(nm * 0.80)}</td>
            <td>\${r.avg_nocenja ? parseFloat(r.avg_nocenja).toFixed(1) : '—'}</td>
            <td>
              <div style="display:flex;align-items:center;gap:8px">
                <div class="progress-bar" style="width:60px">
                  <div class="progress-fill" style="width:\${Math.min(stopa * 3, 100)}%;background:\${stopaColor}"></div>
                </div>
                <span style="font-size:12px;color:\${stopaColor}">\${stopa}%</span>
              </div>
            </td>
          </tr>\`
        }).join('')}
        </tbody></table>
      </div>
    </div>
  \`
}

// ═══════════════════════════════════════════
// STATUS FILTER TABELA
// ═══════════════════════════════════════════
let statusPageState = { status: '', page: 0, pageSize: 25, total: 0 }

async function loadStatusTable(status, cardEl) {
  // Highlight selektovane kartice
  document.querySelectorAll('.status-filter-card').forEach(c => {
    c.style.borderColor = c.dataset.status === status
      ? (getStatusColor(status) + 'cc')
      : (getStatusColor(c.dataset.status) + '33')
    c.style.background = c.dataset.status === status ? '#1e293b' : '#0f172a'
  })

  statusPageState.status = status
  statusPageState.page = 0

  const card = document.getElementById('status-table-card')
  card.style.display = 'block'
  card.scrollIntoView({ behavior: 'smooth', block: 'start' })

  document.getElementById('status-table-title').textContent =
    (STATUS_LABELS[status] || status) + ' — rezervacije'
  document.getElementById('status-tbody').innerHTML =
    '<tr><td colspan="10" class="loading"><i class="fas fa-circle-notch spin"></i> Učitavanje...</td></tr>'

  await fetchStatusPage()
}

async function fetchStatusPage() {
  const { status, page, pageSize } = statusPageState
  const offset = page * pageSize

  try {
    const resp = await axios.get(
      \`/api/rezervacije/po-statusu?status=\${status}&limit=\${pageSize}&offset=\${offset}&\${dateParams()}\`
    )
    const rows = resp.data.rows || []
    const stats = resp.data.stats || {}

    statusPageState.total = parseInt(stats.total || 0)

    // Subtitle sa agregatima
    document.getElementById('status-table-sub').innerHTML =
      \`<span style="color:#10b981;font-weight:600">\${fmtInt(stats.total)} rezervacija</span> &nbsp;•&nbsp;
       Ukupno: <span style="color:#10b981;font-weight:600">\${fmtEur(stats.ukupno_eur)}</span> &nbsp;•&nbsp;
       Prosečna cena: <span style="color:#f59e0b">\${fmtEur(stats.prosecna_cena)}</span> &nbsp;•&nbsp;
       Avg. noćenja: <span style="color:#8b5cf6">\${stats.avg_nocenja ? parseFloat(stats.avg_nocenja).toFixed(1) : '—'}</span>\`

    // Paginacija info
    const from = offset + 1
    const to = Math.min(offset + rows.length, statusPageState.total)
    document.getElementById('status-pagination-info').textContent =
      \`Prikazano \${from}–\${to} od \${fmtInt(statusPageState.total)} rezervacija\`

    document.getElementById('btn-prev-page').disabled = page === 0
    document.getElementById('btn-next-page').disabled = to >= statusPageState.total

    // Tabela
    document.getElementById('status-tbody').innerHTML = rows.length === 0
      ? '<tr><td colspan="10" style="text-align:center;color:#475569;padding:32px">Nema rezervacija za ovaj status u izabranom periodu</td></tr>'
      : rows.map(r => {
          const cena = parseFloat(r.price || 0)
          const net = parseFloat(r.net_price || 0)
          const komisija = r.commission_type === 'percent'
            ? Math.round(cena * (r.commission_value || 0) / 100 * 100) / 100
            : (r.commission_value || 0)
          return \`<tr>
            <td><code style="font-size:11px;color:#60a5fa">\${r.reference || '—'}</code></td>
            <td style="font-weight:500">\${r.agencija || '—'}</td>
            <td style="font-size:12px;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="\${r.hotel_name||''}">\${r.hotel_name || '—'}</td>
            <td>\${r.checkin || '—'}</td>
            <td style="text-align:center">\${r.nights || '—'}</td>
            <td style="color:#10b981;font-weight:600">\${fmtEur(cena)}</td>
            <td style="color:#64748b;font-size:12px">\${net > 0 ? fmtEur(net) : '—'}</td>
            <td>\${payBadge(r.payment_status)}</td>
            <td style="font-size:12px;color:#94a3b8">\${r.payment_method || '—'}</td>
            <td style="font-size:12px;color:#64748b">\${r.created_at ? r.created_at.split('T')[0] : '—'}</td>
          </tr>\`
        }).join('')

    // Resetuj search
    const searchEl = document.getElementById('status-search')
    if (searchEl) searchEl.value = ''

  } catch(e) {
    document.getElementById('status-tbody').innerHTML =
      '<tr><td colspan="10" style="color:#ef4444;text-align:center;padding:24px">Greška pri učitavanju podataka</td></tr>'
  }
}

async function statusPage(dir) {
  const newPage = statusPageState.page + dir
  if (newPage < 0) return
  const maxPage = Math.ceil(statusPageState.total / statusPageState.pageSize) - 1
  if (newPage > maxPage) return
  statusPageState.page = newPage
  await fetchStatusPage()
  document.getElementById('status-table-card').scrollIntoView({ behavior: 'smooth', block: 'start' })
}

function closeStatusTable() {
  document.getElementById('status-table-card').style.display = 'none'
  document.querySelectorAll('.status-filter-card').forEach(c => {
    c.style.borderColor = getStatusColor(c.dataset.status) + '33'
    c.style.background = '#0f172a'
  })
}

function getStatusColor(status) {
  const map = {
    accepted: '#10b981', rejected: '#ef4444', pending: '#f59e0b',
    none: '#64748b', cancelled_refund: '#f97316', cancelled_transfer: '#fb923c',
    cancelled_penalty: '#dc2626', overpayment: '#3b82f6'
  }
  return map[status] || '#64748b'
}

// ═══════════════════════════════════════════
// MOBILNI HELPERS
// ═══════════════════════════════════════════
function toggleSidebar() {
  const s = document.getElementById('sidebar')
  const o = document.getElementById('sidebar-overlay')
  const open = s.classList.toggle('open')
  o.classList.toggle('show', open)
  document.body.style.overflow = open ? 'hidden' : ''
}

function closeSidebar() {
  document.getElementById('sidebar').classList.remove('open')
  document.getElementById('sidebar-overlay').classList.remove('show')
  document.body.style.overflow = ''
}

// Zatvori sidebar pri navigaciji na mobilnom
const _origShowModule = showModule
window.showModule = function(name) {
  _origShowModule(name)
  // ažuriraj topbar naslov
  const cfg = moduleConfig[name]
  if (cfg) document.getElementById('topbar-title').textContent = cfg.title
  // ažuriraj bottom nav active
  document.querySelectorAll('.bottom-nav-item').forEach(el => {
    el.classList.toggle('active', el.dataset.module === name)
  })
  // zatvori sidebar na mobilnom
  if (window.innerWidth <= 768) closeSidebar()
}

// ═══════════════════════════════════════════
// INIT
// ═══════════════════════════════════════════
initDates()
document.getElementById('last-refresh').textContent = new Date().toLocaleTimeString('sr')
showModule('pregled')
</script>

<!-- BOTTOM NAV (samo mobile) -->
<nav class="bottom-nav" id="bottom-nav">
  <div class="bottom-nav-inner">
    <button class="bottom-nav-item active" data-module="pregled" onclick="showModule('pregled')">
      <i class="fas fa-th-large"></i>
      <span>Pregled</span>
    </button>
    <button class="bottom-nav-item" data-module="finansije" onclick="showModule('finansije')">
      <i class="fas fa-chart-line"></i>
      <span>Finansije</span>
    </button>
    <button class="bottom-nav-item" data-module="rezervacije" onclick="showModule('rezervacije')">
      <i class="fas fa-calendar-check"></i>
      <span>Rezervacije</span>
    </button>
    <button class="bottom-nav-item" data-module="agencije" onclick="showModule('agencije')">
      <i class="fas fa-building"></i>
      <span>Agencije</span>
    </button>
    <button class="bottom-nav-item" data-module="_more" onclick="toggleSidebar()">
      <i class="fas fa-ellipsis-h"></i>
      <span>Više</span>
    </button>
  </div>
</nav>

</body>
</html>`

export default app
