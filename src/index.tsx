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
<title>Tiara Holidays — BI Dashboard</title>
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
