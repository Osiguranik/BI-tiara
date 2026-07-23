// MySQL Gateway klijent - HMAC-SHA256 potpis
// Credentials se čuvaju kao Cloudflare environment varijable

export interface GatewayConfig {
  url: string
  keyId: string
  secret: string
}

export interface QueryResult {
  ok: boolean
  data?: {
    rows: Record<string, unknown>[]
    rowCount: number
  }
  error?: string
}

async function hmacSha256(secret: string, message: string): Promise<string> {
  const enc = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message))
  return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('')
}

async function sha256(data: string): Promise<string> {
  const enc = new TextEncoder()
  const hash = await crypto.subtle.digest('SHA-256', enc.encode(data))
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('')
}

function randomHex(bytes: number): string {
  const arr = new Uint8Array(bytes)
  crypto.getRandomValues(arr)
  return Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('')
}

export async function query(
  config: GatewayConfig,
  sql: string,
  params: unknown[] | Record<string, unknown> | null = null
): Promise<QueryResult> {
  const body = JSON.stringify({ sql, params })
  const url = new URL(config.url)
  const pathOnly = url.pathname

  const ts = Math.floor(Date.now() / 1000).toString()
  const nonce = randomHex(16)
  const bodyHash = await sha256(body)
  const canonical = ['POST', pathOnly, ts, nonce, bodyHash].join('\n')
  const signature = await hmacSha256(config.secret, canonical)

  const resp = await fetch(config.url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Key-Id': config.keyId,
      'X-Timestamp': ts,
      'X-Nonce': nonce,
      'X-Signature': signature,
    },
    body,
  })

  return resp.json() as Promise<QueryResult>
}
