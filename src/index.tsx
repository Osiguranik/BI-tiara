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
