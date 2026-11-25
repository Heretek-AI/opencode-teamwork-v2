// opencode-teamwork — outbound URL guard (SSRF defence)
//
// URL ingestion (document-review), input preflight, and the CLI OIDC JWKS
// fetch can otherwise reach loopback, private, link-local, and cloud-metadata
// endpoints. This module:
//   * accepts only http/https URLs;
//   * resolves the hostname itself and refuses loopback, private, link-local,
//     unspecified, multicast/reserved, documentation, and metadata addresses
//     (IPv4, IPv6, and IPv4-mapped/compatible IPv6);
//   * pins the connection to the validated address (`lookup`), so a second DNS
//     answer cannot rebind the request after the check;
//   * never follows redirects automatically. Callers validate any `Location`
//     themselves before deciding what to do.
//
// `OPENCODE_TEAMWORK_ALLOW_LOCALHOST=1` is an explicit test/development opt-in
// that permits loopback addresses only (never private/link-local/metadata).
// The default is deny.
//
// Plain ESM with zero runtime dependencies. Type declarations live in
// `url-guard.d.mts`.

import { lookup as dnsLookup } from "node:dns/promises"
import { isIP } from "node:net"
import { request as httpRequest } from "node:http"
import { request as httpsRequest } from "node:https"

export const ALLOW_LOCALHOST_ENV = "OPENCODE_TEAMWORK_ALLOW_LOCALHOST"

function localhostOptInEnabled() {
  return process.env[ALLOW_LOCALHOST_ENV] === "1"
}

function refuse(code, error) {
  return { ok: false, code, error }
}

function normalizeHost(hostname) {
  return hostname.replace(/^\[/, "").replace(/\]$/, "").replace(/\.$/, "").toLowerCase()
}

function parseIpv4(value) {
  const parts = value.split(".")
  if (parts.length !== 4) return undefined
  let n = 0
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return undefined
    const octet = Number(part)
    if (octet < 0 || octet > 255) return undefined
    n = ((n << 8) | octet) >>> 0
  }
  return n
}

function ipv4BlockedReason(n, allowLocalhost) {
  const inRange = (base, bits) => {
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0
    return (n & mask) === (parseIpv4(base) & mask)
  }
  if (inRange("127.0.0.0", 8)) return allowLocalhost ? undefined : "loopback"
  if (inRange("0.0.0.0", 8)) return "unspecified"
  if (inRange("10.0.0.0", 8)) return "private"
  if (inRange("100.64.0.0", 10)) return "carrier-grade NAT"
  if (inRange("169.254.0.0", 16)) return n === parseIpv4("169.254.169.254") ? "cloud metadata" : "link-local"
  if (inRange("172.16.0.0", 12)) return "private"
  if (inRange("192.0.0.0", 24)) return "IETF protocol assignment"
  if (inRange("192.0.2.0", 24)) return "documentation"
  if (inRange("192.88.99.0", 24)) return "6to4 relay"
  if (inRange("192.168.0.0", 16)) return "private"
  if (inRange("198.18.0.0", 15)) return "benchmarking"
  if (inRange("198.51.100.0", 24)) return "documentation"
  if (inRange("203.0.113.0", 24)) return "documentation"
  if (inRange("224.0.0.0", 4)) return "multicast"
  if (inRange("240.0.0.0", 4)) return "reserved"
  if (n === 0xffffffff) return "broadcast"
  return undefined
}

function parseIpv6(value) {
  let input = value.toLowerCase()
  const zone = input.indexOf("%")
  if (zone >= 0) input = input.slice(0, zone)
  if (!input.includes(":")) return undefined

  // Convert a trailing embedded IPv4 literal (e.g. ::ffff:127.0.0.1) to two
  // hextets so the rest of the parser has a uniform representation.
  let embeddedIpv4
  const lastColon = input.lastIndexOf(":")
  const tail = lastColon >= 0 ? input.slice(lastColon + 1) : ""
  if (tail.includes(".")) {
    embeddedIpv4 = parseIpv4(tail)
    if (embeddedIpv4 === undefined) return undefined
    const hi = (embeddedIpv4 >>> 16).toString(16)
    const lo = (embeddedIpv4 & 0xffff).toString(16)
    input = `${input.slice(0, lastColon + 1)}${hi}:${lo}`
  }

  const halves = input.split("::")
  if (halves.length > 2) return undefined
  const left = halves[0] ? halves[0].split(":") : []
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : []
  const missing = 8 - left.length - right.length
  if (halves.length === 1) {
    if (left.length !== 8) return undefined
  } else if (missing < 0) {
    return undefined
  }
  const hextets = [...left, ...Array(halves.length === 2 ? missing : 0).fill("0"), ...right]
  if (hextets.length !== 8) return undefined
  const bytes = []
  for (const hextet of hextets) {
    if (!/^[0-9a-f]{1,4}$/.test(hextet)) return undefined
    const word = parseInt(hextet, 16)
    bytes.push((word >>> 8) & 0xff, word & 0xff)
  }
  return bytes
}

function ipv6BlockedReason(bytes, allowLocalhost) {
  const allZeroPrefix = (count) => bytes.slice(0, count).every((b) => b === 0)
  if (allZeroPrefix(16)) return "unspecified"
  if (allZeroPrefix(15) && bytes[15] === 1) return allowLocalhost ? undefined : "loopback"
  const isMapped = allZeroPrefix(10) && bytes[10] === 0xff && bytes[11] === 0xff
  const isCompatible = allZeroPrefix(12)
  if (isMapped || isCompatible) {
    const v4 = ((bytes[12] << 24) | (bytes[13] << 16) | (bytes[14] << 8) | bytes[15]) >>> 0
    return ipv4BlockedReason(v4, allowLocalhost)
  }
  // Only global unicast (2000::/3) may be reached.
  if ((bytes[0] & 0xe0) !== 0x20) {
    if ((bytes[0] & 0xfe) === 0xfc) return "unique-local"
    if (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0x80) return "link-local"
    if (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0xc0) return "site-local"
    if (bytes[0] === 0xff) return "multicast"
    return "non-global"
  }
  // Documentation (2001:db8::/32), 6to4 (2002::/16), Teredo (2001::/32),
  // ORCHID (2001:10::/28 and 2001:20::/28), and 3fff::/20 documentation.
  if (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0x0d && bytes[3] === 0xb8) return "documentation"
  if (bytes[0] === 0x20 && bytes[1] === 0x02) return "6to4"
  if (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0x00 && bytes[3] === 0x00) return "Teredo"
  if (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0x00 && (bytes[3] === 0x10 || bytes[3] === 0x20)) return "ORCHID"
  if (bytes[0] === 0x3f && bytes[1] === 0xff && (bytes[2] & 0xf0) === 0) return "documentation"
  return undefined
}

/** Classify one resolved address. Returns a human-readable reason when blocked. */
export function blockedAddressReason(address, allowLocalhost = false) {
  const value = normalizeHost(address)
  const family = isIP(value)
  if (family === 4) {
    const n = parseIpv4(value)
    return n === undefined ? "invalid address" : ipv4BlockedReason(n, allowLocalhost)
  }
  if (family === 6) {
    const bytes = parseIpv6(value)
    return bytes === undefined ? "invalid address" : ipv6BlockedReason(bytes, allowLocalhost)
  }
  return "not an IP address"
}

/**
 * Validate and normalize a local OpenCode service origin URL (from `service*.json`).
 * Only `http:` / `https:` origins pointing at loopback IPs (`127.0.0.0/8`, `::1`,
 * `::ffff:127.0.0.0/8`) or `localhost` / `*.localhost` with no credentials,
 * path, query, or fragment are accepted. Returns a reconstructed clean origin
 * string (`http(s)://host[:port]`) or `undefined`.
 */
export function parseLoopbackServiceUrl(rawUrl) {
  let parsed
  try {
    parsed = new URL(String(rawUrl || "").trim())
  } catch {
    return undefined
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined
  if (parsed.username || parsed.password) return undefined
  if ((parsed.pathname !== "/" && parsed.pathname !== "") || parsed.search || parsed.hash) return undefined
  const host = normalizeHost(parsed.hostname)
  if (!host) return undefined
  const family = isIP(host)
  if (family !== 0) {
    if (blockedAddressReason(host, false) !== "loopback" || blockedAddressReason(host, true) !== undefined) {
      return undefined
    }
  } else if (host !== "localhost" && !host.endsWith(".localhost")) {
    return undefined
  }
  let portSuffix = ""
  if (parsed.port) {
    if (!/^\d{1,5}$/.test(parsed.port)) return undefined
    const portNum = Number(parsed.port)
    if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) return undefined
    portSuffix = `:${portNum}`
  }
  const scheme = parsed.protocol === "https:" ? "https:" : "http:"
  const hostAuthority = parsed.hostname.startsWith("[") ? `[${host}]` : host
  return `${scheme}//${hostAuthority}${portSuffix}`
}

/**
 * Validate a URL and resolve every address it names. All answers must be
 * public; a hostname with one private answer is refused as a whole.
 */
export async function assertSafeUrl(rawUrl, options = {}) {
  let parsed
  try {
    parsed = new URL(String(rawUrl || "").trim())
  } catch {
    return refuse("URL_INVALID", "invalid URL")
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return refuse("URL_PROTOCOL", `unsupported URL protocol "${parsed.protocol}" (http/https only)`)
  }
  if (parsed.username || parsed.password) {
    return refuse("URL_CREDENTIALS", "URLs with embedded credentials are not fetched")
  }

  const loopbackOnly = options.loopbackOnly === true
  const allowLocalhost = loopbackOnly ? true : (options.allowLocalhost ?? localhostOptInEnabled())
  const host = normalizeHost(parsed.hostname)
  if (!host) return refuse("URL_INVALID", "URL has no hostname")

  const literal = isIP(host)
  let addresses
  if (literal) {
    const family = literal
    addresses = [{ address: host, family }]
  } else {
    if (loopbackOnly && host !== "localhost" && !host.endsWith(".localhost")) {
      return refuse("URL_BLOCKED_ADDRESS", `URL host "${host}" is not a loopback address`)
    }
    if ((host === "localhost" || host.endsWith(".localhost")) && !allowLocalhost) {
      return refuse("URL_BLOCKED_ADDRESS", "URL host is localhost (loopback is blocked; set OPENCODE_TEAMWORK_ALLOW_LOCALHOST=1 only for local tests)")
    }
    try {
      if (options.resolveHost) {
        addresses = await options.resolveHost(host)
      } else {
        const answers = await dnsLookup(host, { all: true, verbatim: true })
        addresses = answers
          .filter((entry) => entry.family === 4 || entry.family === 6)
          .map((entry) => ({ address: entry.address, family: entry.family }))
      }
    } catch (err) {
      return refuse("URL_DNS", `URL host could not be resolved (${String(err?.code || err?.message || "DNS error").slice(0, 120)})`)
    }
    if (addresses.length === 0) return refuse("URL_DNS", "URL host resolved to no addresses")
  }

  for (const entry of addresses) {
    if (loopbackOnly) {
      if (blockedAddressReason(entry.address, false) !== "loopback" || blockedAddressReason(entry.address, true) !== undefined) {
        return refuse("URL_BLOCKED_ADDRESS", `URL resolves to a non-loopback address (${entry.address})`)
      }
    } else {
      const reason = blockedAddressReason(entry.address, allowLocalhost)
      if (reason) {
        return refuse("URL_BLOCKED_ADDRESS", `URL resolves to a blocked ${reason} address (${entry.address})`)
      }
    }
  }

  return { ok: true, url: parsed, addresses, allowLocalhost }
}

function requestPinned(safe, options, address) {
  if (options.signal?.aborted) {
    return Promise.resolve(refuse("URL_TIMEOUT", "URL request timed out"))
  }
  const method = options.method === "HEAD" ? "HEAD" : "GET"
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : 5000
  const maxBytes = Number.isFinite(options.maxBytes) && options.maxBytes > 0 ? options.maxBytes : 5 * 1024 * 1024
  const url = safe.url
  const host = normalizeHost(url.hostname)
  const isIpHost = isIP(host) !== 0

  return new Promise((resolvePromise) => {
    let settled = false
    const done = (result) => {
      if (settled) return
      settled = true
      resolvePromise(result)
    }

    const lookup = (_hostname, lookupOptions, callback) => {
      if (lookupOptions && lookupOptions.all) {
        callback(null, [{ address: address.address, family: address.family }])
        return
      }
      callback(null, address.address, address.family)
    }

    let req
    try {
      const requestImpl = url.protocol === "https:" ? httpsRequest : httpRequest
      req = requestImpl(
        {
          protocol: url.protocol,
          hostname: host,
          port: url.port || undefined,
          path: `${url.pathname || "/"}${url.search || ""}`,
          method,
          headers: options.headers,
          lookup,
          ...(url.protocol === "https:" && !isIpHost ? { servername: host } : {}),
        },
        (res) => {
          const headers = res.headers || {}
          const contentLength = Number(headers["content-length"] || 0)
          if (Number.isFinite(contentLength) && contentLength > maxBytes) {
            res.resume()
            done(refuse("URL_TOO_LARGE", `response exceeds ${maxBytes} byte limit`))
            return
          }
          if (method === "HEAD") {
            res.resume()
            done({ ok: true, status: Number(res.statusCode) || 0, headers })
            return
          }
          const chunks = []
          let total = 0
          res.on("data", (chunk) => {
            total += chunk.length
            if (total > maxBytes) {
              try {
                res.destroy()
              } catch {}
              done(refuse("URL_TOO_LARGE", `response exceeds ${maxBytes} byte limit`))
              return
            }
            chunks.push(Buffer.from(chunk))
          })
          res.on("end", () => {
            done({ ok: true, status: Number(res.statusCode) || 0, headers, body: Buffer.concat(chunks, total) })
          })
          res.on("error", (err) => {
            done(refuse("URL_NETWORK", `URL request failed (${String(err?.code || err?.message || "network error").slice(0, 120)})`))
          })
        },
      )
    } catch (err) {
      done(refuse("URL_NETWORK", `URL request failed (${String(err?.code || err?.message || "network error").slice(0, 120)})`))
      return
    }

    // A total deadline (not just socket inactivity): a slow-drip response must
    // be cancellable end-to-end. The caller owns the signal/timer.
    const onAbort = () => {
      const err = new Error("timeout")
      err.code = "URL_TIMEOUT"
      req.destroy(err)
    }
    if (options.signal) {
      options.signal.addEventListener("abort", onAbort, { once: true })
      req.on("close", () => options.signal.removeEventListener("abort", onAbort))
    }

    req.setTimeout(timeoutMs, () => {
      const err = new Error("timeout")
      err.code = "URL_TIMEOUT"
      req.destroy(err)
    })
    req.on("error", (err) => {
      if (err?.code === "URL_TIMEOUT" || err?.code === "ETIMEDOUT") {
        done(refuse("URL_TIMEOUT", "URL request timed out"))
        return
      }
      done(refuse("URL_NETWORK", `URL request failed (${String(err?.code || err?.message || "network error").slice(0, 120)})`))
    })
    req.end()
  })
}

/**
 * Fetch a URL through the guard. Redirects are NOT followed (3xx is returned to
 * the caller); callers that choose to follow one must validate the target with
 * `assertSafeUrl` first. The connection is pinned to the validated address.
 */
export async function safeFetch(rawUrl, options = {}) {
  const safe = await assertSafeUrl(rawUrl, {
    allowLocalhost: options.allowLocalhost,
    loopbackOnly: options.loopbackOnly,
    resolveHost: options.resolveHost,
  })
  if (!safe.ok) return safe
  let last
  for (const address of safe.addresses) {
    const result = await requestPinned(safe, options, address)
    if (result.ok) return result
    last = result
    // Only try the next address when the connection itself failed.
    if (result.code !== "URL_NETWORK") return result
  }
  return last ?? refuse("URL_NETWORK", "URL request failed")
}
