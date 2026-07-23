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
    query(g, `SELECT COUNT(*) as total, SUM(price) as ukupno_eur, SUM(net_price) as ukupno_net
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
     LIMIT 30`, [from, to])

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
<title>Tiara Travel — BI Dashboard</title>
<script src="https://cdn.tailwindcss.com"></script>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/axios@1.6.0/dist/axios.min.js"></script>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.4.0/css/all.min.css">
<style>
  * { box-sizing: border-box; }
  body { font-family: 'Segoe UI', system-ui, sans-serif; background: #0f172a; color: #e2e8f0; }
  ::-webkit-scrollbar { width: 6px; height: 6px; }
  ::-webkit-scrollbar-track { background: #1e293b; }
  ::-webkit-scrollbar-thumb { background: #475569; border-radius: 3px; }
  .sidebar { width: 240px; min-height: 100vh; background: #1e293b; border-right: 1px solid #334155; position: fixed; top: 0; left: 0; z-index: 100; transition: transform .3s; }
  .sidebar-link { display: flex; align-items: center; gap: 10px; padding: 10px 16px; border-radius: 8px; cursor: pointer; transition: all .2s; font-size: 14px; color: #94a3b8; margin: 2px 8px; }
  .sidebar-link:hover { background: #334155; color: #e2e8f0; }
  .sidebar-link.active { background: #3b82f6; color: #fff; }
  .main { margin-left: 240px; padding: 24px; min-height: 100vh; }
  .card { background: #1e293b; border: 1px solid #334155; border-radius: 12px; padding: 20px; }
  .kpi-card { background: linear-gradient(135deg, #1e293b, #0f172a); border: 1px solid #334155; border-radius: 12px; padding: 20px; position: relative; overflow: hidden; }
  .kpi-card::before { content:''; position:absolute; top:-30px; right:-30px; width:100px; height:100px; border-radius:50%; opacity:.1; }
  .kpi-blue::before { background:#3b82f6; }
  .kpi-green::before { background:#10b981; }
  .kpi-yellow::before { background:#f59e0b; }
  .kpi-red::before { background:#ef4444; }
  .kpi-purple::before { background:#8b5cf6; }
  .btn { padding: 8px 16px; border-radius: 8px; border: none; cursor: pointer; font-size: 13px; font-weight: 500; transition: all .2s; }
  .btn-primary { background: #3b82f6; color: #fff; }
  .btn-primary:hover { background: #2563eb; }
  .btn-ghost { background: #334155; color: #94a3b8; }
  .btn-ghost:hover { background: #475569; color: #e2e8f0; }
  .tab { padding: 8px 16px; border-radius: 8px; cursor: pointer; font-size: 13px; color: #64748b; transition: all .2s; }
  .tab.active { background: #3b82f6; color: #fff; }
  .tab:hover:not(.active) { background: #334155; color: #94a3b8; }
  input[type=date], select { background: #0f172a; border: 1px solid #334155; color: #e2e8f0; border-radius: 8px; padding: 8px 12px; font-size: 13px; outline: none; }
  input[type=date]:focus, select:focus { border-color: #3b82f6; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th { background: #0f172a; padding: 10px 12px; text-align: left; color: #64748b; font-weight: 600; font-size: 11px; text-transform: uppercase; letter-spacing: .05em; border-bottom: 1px solid #334155; position: sticky; top: 0; z-index: 1; }
  td { padding: 10px 12px; border-bottom: 1px solid #1e293b; color: #cbd5e1; }
  tr:hover td { background: #1e293b; }
  .badge { display:inline-block; padding:2px 8px; border-radius:999px; font-size:11px; font-weight:600; }
  .badge-green { background:#064e3b; color:#34d399; }
  .badge-red { background:#450a0a; color:#f87171; }
  .badge-yellow { background:#451a03; color:#fbbf24; }
  .badge-blue { background:#1e3a5f; color:#60a5fa; }
  .badge-gray { background:#1e293b; color:#94a3b8; }
  .loading { display:flex; align-items:center; justify-content:center; gap:8px; color:#64748b; padding:40px; }
  .spin { animation: spin 1s linear infinite; }
  @keyframes spin { from{transform:rotate(0deg)} to{transform:rotate(360deg)} }
  .chart-container { position:relative; width:100%; }
  .progress-bar { height:6px; background:#1e293b; border-radius:3px; overflow:hidden; }
  .progress-fill { height:100%; background: linear-gradient(90deg, #3b82f6, #8b5cf6); border-radius:3px; transition: width .6s ease; }
  .tooltip-custom { position:absolute; background:#0f172a; border:1px solid #334155; border-radius:8px; padding:8px 12px; font-size:12px; pointer-events:none; z-index:999; }
  @media(max-width:768px) { .sidebar{transform:translateX(-100%);} .sidebar.open{transform:translateX(0);} .main{margin-left:0;} }
</style>
</head>
<body>

<!-- SIDEBAR -->
<aside class="sidebar" id="sidebar">
  <div style="padding:20px 16px 12px">
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:4px">
      <div style="background:#3b82f6;border-radius:8px;width:32px;height:32px;display:flex;align-items:center;justify-content:center">
        <i class="fas fa-plane-departure" style="color:#fff;font-size:14px"></i>
      </div>
      <div>
        <div style="font-weight:700;font-size:15px;color:#f1f5f9">Tiara Travel</div>
        <div style="font-size:11px;color:#64748b">BI Dashboard</div>
      </div>
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

  <div style="position:absolute;bottom:16px;left:0;right:0;padding:0 16px">
    <div style="font-size:11px;color:#334155;text-align:center">Poslednje osveženo: <span id="last-refresh">-</span></div>
    <button class="btn btn-ghost" style="width:100%;margin-top:8px;font-size:12px" onclick="refreshAll()">
      <i class="fas fa-sync-alt"></i> Osvezi podatke
    </button>
  </div>
</aside>

<!-- MAIN -->
<main class="main">

  <!-- HEADER -->
  <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:24px;flex-wrap:wrap;gap:12px">
    <div>
      <h1 id="page-title" style="font-size:22px;font-weight:700;color:#f1f5f9">Glavni pregled</h1>
      <div id="page-subtitle" style="font-size:13px;color:#64748b;margin-top:2px">Svi ključni pokazatelji na jednom mestu</div>
    </div>
    <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
      <!-- Brzi filteri -->
      <div style="display:flex;gap:4px;background:#1e293b;padding:4px;border-radius:10px">
        <button class="tab active" id="quick-30d" onclick="setQuickDate(30, this)">30 dana</button>
        <button class="tab" id="quick-90d" onclick="setQuickDate(90, this)">3 mes.</button>
        <button class="tab" id="quick-180d" onclick="setQuickDate(180, this)">6 mes.</button>
        <button class="tab" id="quick-1y" onclick="setQuickDate(365, this)">1 god.</button>
      </div>
      <input type="date" id="date-from" onchange="onDateChange()">
      <span style="color:#475569">—</span>
      <input type="date" id="date-to" onchange="onDateChange()">
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
  const now = new Date()
  const past = new Date(now)
  past.setDate(past.getDate() - 30)
  dateTo = now.toISOString().split('T')[0]
  dateFrom = past.toISOString().split('T')[0]
  document.getElementById('date-from').value = dateFrom
  document.getElementById('date-to').value = dateTo
}

function setQuickDate(days, btn) {
  document.querySelectorAll('.tab[id^=quick]').forEach(t => t.classList.remove('active'))
  btn.classList.add('active')
  const now = new Date()
  const past = new Date(now)
  past.setDate(past.getDate() - days)
  dateTo = now.toISOString().split('T')[0]
  dateFrom = past.toISOString().split('T')[0]
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
        <div style="font-size:12px;color:#64748b;margin-top:4px">vrednost rezervacija</div>
      </div>
      <div class="kpi-card kpi-purple">
        <div style="font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:.08em;margin-bottom:8px"><i class="fas fa-check-circle mr-1"></i> Naplaćeno (EUR)</div>
        <div style="font-size:24px;font-weight:700;color:#8b5cf6">\${fmtEur(d.placanja?.naplaceno_eur)}</div>
        <div style="font-size:12px;color:#64748b;margin-top:4px">\${fmtInt(d.placanja?.cnt)} uplata</div>
      </div>
      <div class="kpi-card kpi-yellow">
        <div style="font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:.08em;margin-bottom:8px"><i class="fas fa-check-double mr-1"></i> Prihvaćene rez.</div>
        <div style="font-size:28px;font-weight:700;color:#f59e0b">\${fmtInt(prihvacene)}</div>
        <div style="font-size:12px;color:#64748b;margin-top:4px">od ukupno \${fmtInt(d.rezervacije?.total)}</div>
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
        <div style="font-weight:600;margin-bottom:12px;font-size:14px;color:#f1f5f9">Mesečni detalji raspodele</div>
        <div style="overflow:auto;max-height:320px">
          <table><thead><tr>
            <th>Mesec</th>
            <th>Ukupan prihod</th>
            <th>Net trošak</th>
            <th>Gross marža</th>
            <th style="color:#fcd34d">Komisije agt.</th>
            <th style="color:#6ee7b7">Naša marža</th>
            <th>Naša marža %</th>
          </tr></thead><tbody>
          \${mesecni.map(r=>{
            const gm = parseFloat(r.gross_marza||0)
            const nm = parseFloat(r.nasa_marza||0)
            const nmPct = gm > 0 ? fmt(nm/gm*100,1) : '—'
            return \`<tr>
              <td style="font-weight:600">\${r.mesec}</td>
              <td style="color:#10b981">\${fmtEur(r.ukupan_prihod)}</td>
              <td style="color:#3b82f6">\${fmtEur(r.net_troskovi)}</td>
              <td style="color:#8b5cf6">\${fmtEur(r.gross_marza)}</td>
              <td style="color:#f59e0b;font-weight:600">\${fmtEur(r.komisije_agencijama)}</td>
              <td style="color:#10b981;font-weight:700">\${fmtEur(r.nasa_marza)}</td>
              <td style="font-size:12px;color:\${nm>0?'#10b981':'#ef4444'}">\${nmPct}%</td>
            </tr>\`
          }).join('')}
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
    content.innerHTML = \`
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px">
        <div class="card">
          <div style="font-weight:600;margin-bottom:16px;font-size:14px;color:#f1f5f9">Status rezervacija</div>
          <div class="chart-container" style="height:280px"><canvas id="chart-rez-status"></canvas></div>
        </div>
        <div class="card">
          <div style="font-weight:600;margin-bottom:16px;font-size:14px;color:#f1f5f9">Platni status</div>
          <div class="chart-container" style="height:280px"><canvas id="chart-rez-pay"></canvas></div>
        </div>
      </div>
    \`
    const statusi = d.statusi || []
    makeChart('chart-rez-status','doughnut',{
      labels:statusi.map(r=>STATUS_LABELS[r.status]||r.status),
      datasets:[{data:statusi.map(r=>r.cnt),backgroundColor:COLORS}]
    },{plugins:{legend:{position:'right',labels:{color:'#94a3b8',font:{size:11}}}}})
    const plat = d.platni_status || []
    makeChart('chart-rez-pay','doughnut',{
      labels:plat.map(r=>PAY_LABELS[r.payment_status]||r.payment_status),
      datasets:[{data:plat.map(r=>r.cnt),backgroundColor:['#10b981','#f59e0b','#64748b','#3b82f6','#8b5cf6']}]
    },{plugins:{legend:{position:'right',labels:{color:'#94a3b8',font:{size:11}}}}})
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
    const rang = d.rang || []
    content.innerHTML = \`
      <div class="card">
        <div style="font-size:12px;color:#475569;margin-bottom:12px;padding:8px 12px;background:#0f172a;border-radius:8px;border:1px solid #1e3a5f">
          <i class="fas fa-info-circle mr-1" style="color:#3b82f6"></i>
          <strong style="color:#93c5fd">Gross marža</strong> = Prihod − Net trošak &nbsp;|&nbsp;
          <strong style="color:#fcd34d">Komisija agenciji</strong> = Prihod × % (ili fiksni iznos) &nbsp;|&nbsp;
          <strong style="color:#6ee7b7">Naša marža</strong> = Gross − Komisija
        </div>
        <div style="overflow:auto;max-height:580px">
          <table><thead><tr>
            <th>#</th><th>Agencija</th><th>Rez.</th><th>Prihod (EUR)</th>
            <th>Gross marža</th><th style="color:#fcd34d">Komisija agt.</th>
            <th style="color:#6ee7b7">Naša marža</th>
            <th>Avg. noć.</th><th>Stopa otk. %</th>
          </tr></thead><tbody>
          \${rang.map((r,i)=>\`<tr>
            <td style="color:#64748b;font-weight:600">\${i+1}</td>
            <td style="font-weight:600;color:#f1f5f9">\${r.name}</td>
            <td>\${fmtInt(r.rezervacije)}</td>
            <td style="color:#10b981;font-weight:600">\${fmtEur(r.prihod)}</td>
            <td style="color:#8b5cf6">\${fmtEur(r.gross_marza)}</td>
            <td style="color:#f59e0b;font-weight:600">\${fmtEur(r.komisija_agenciji)}</td>
            <td style="color:#10b981;font-weight:700">\${fmtEur(r.nasa_marza)}</td>
            <td>\${r.avg_nocenja?parseFloat(r.avg_nocenja).toFixed(1):'—'}</td>
            <td>
              <div style="display:flex;align-items:center;gap:8px">
                <div class="progress-bar" style="width:60px">
                  <div class="progress-fill" style="width:\${Math.min(parseFloat(r.stopa_otkazivanja||0)*3,100)}%;background:\${r.stopa_otkazivanja>20?'#ef4444':r.stopa_otkazivanja>10?'#f59e0b':'#10b981'}"></div>
                </div>
                <span style="font-size:12px;color:\${r.stopa_otkazivanja>20?'#ef4444':r.stopa_otkazivanja>10?'#f59e0b':'#10b981'}">\${r.stopa_otkazivanja||0}%</span>
              </div>
            </td>
          </tr>\`).join('')}
          </tbody></table>
        </div>
      </div>
    \`
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
            <th>Prosečna vred.</th><th>Poslednja rez.</th>
          </tr></thead><tbody id="agt-tbody">
          \${lista.map(u=>\`<tr>
            <td style="font-weight:600">\${u.name}</td>
            <td>\${u.is_active?'<span class="badge badge-green">Aktivan</span>':'<span class="badge badge-gray">Neaktivan</span>'}</td>
            <td>\${fmtInt(u.broj_rezervacija)}</td>
            <td style="color:#10b981">\${fmtInt(u.prihvacene)}</td>
            <td style="color:#10b981;font-weight:600">\${fmtEur(u.ukupan_prihod)}</td>
            <td style="color:#8b5cf6">\${fmtEur(u.gross_marza)}</td>
            <td style="color:#f59e0b;font-weight:600">\${fmtEur(u.komisija_agenciji)}</td>
            <td style="color:#10b981;font-weight:700">\${fmtEur(u.nasa_marza)}</td>
            <td style="color:#64748b">\${fmtEur(u.prosecna_vrednost)}</td>
            <td style="font-size:12px;color:#64748b">\${u.poslednja_rezervacija?.split('T')[0]||'—'}</td>
          </tr>\`).join('')}
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
// INIT
// ═══════════════════════════════════════════
initDates()
document.getElementById('last-refresh').textContent = new Date().toLocaleTimeString('sr')
showModule('pregled')
</script>
</body>
</html>`

export default app
