# DSH Authentication & Network Egress (v0.2.1-alpha.2)

**Conducted:** 2026-11-09 · **Source:** installed `@deepseek-ai/*@0.2.1-alpha.2` package code + READMEs under `node_modules/.pnpm`, plus `src/app/http.ts` and `src/client/api.ts` in this repo.

## TL;DR

Có. DSH có **hai lớp auth hoàn toàn tách biệt**:

1. **Browser → Host login**: launch-token → signed cookie (single operator, không username/password, không multi-user).
2. **Outbound egress**: env-based HTTP(S) proxy (`@deepseek-ai/dsh-http-proxy`), hỗ trợ authenticated proxy qua `user:pass@` trong URL.

Web panel của dsh-superagent (`/orchestrator/api/*`) **không** đi qua lớp cookie auth này — nó tự phòng thủ bằng loopback bind + same-origin check.

## 1. Browser login (dsh-client-connection)

Flow trong `@deepseek-ai/dsh-client-connection` (`README.md`, section "Browser authentication and request trust"):

```mermaid
sequenceDiagram
  participant U as User terminal
  participant D as dsh-web-app (Host)
  participant B as Browser
  U->>D: launch dsh web
  D->>D: mint random launch token (per process)
  D-->>U: print + open URL ?token=...
  B->>D: GET /?token=...
  D-->>B: 303 → ./ (drop token) + Set-Cookie (signed)
  B->>D: every /api RPC + WebSocket with cookie
  D->>D: admit(request): trust fence + cookie verify → operator Peer
```

2. Browser `GET /?token=...` → Host verify token (chỉ so khớp, **không consume/rotate** — token dùng lại được suốt lifetime của process), ký cookie rồi redirect **303** về `./` (token bị gỡ khỏi URL).
- Cookie: `HttpOnly`, `SameSite=Strict`, `Path=/`, host-only; `Secure` khi listener là TLS. TTL mặc định 30 ngày (`cookieMaxAgeDays`). Tên cookie và signed audience bind tới `hostname:port` và scheme — cookie HTTP không dùng được cho listener HTTPS cùng host.
- Token chỉ được chấp nhận tại `GET /` (root exchange) — không một lần, ai giữ URL `?token=...` vẫn mint được cookie cho tới khi process restart (token mới mint mỗi launch). Không nhận query token ngoài root, không nhận `Authorization` header.
- Trước khi auth, mọi request qua request-trust fence: `Host` phải là loopback / bind IP / `trustedHosts` entry; `Origin` phải cùng authority; `sec-fetch-site: cross-site` bị từ chối.
- Mọi request được admit đều nói thay cho **một Peer duy nhất: the operator**. Không có user/account model, không RBAC.
- `dsh-host-webserver` tự nó **không có server-wide auth** ("No server-wide authentication or origin policy — route owners enforce their own request policy. Binding a non-loopback address exposes unprotected routes").

## 2. Model/provider credential

- Adapters kiểu `dsh-llm-deepseek-api-key` lấy key từ env (`apiKeyEnv: DEEPSEEK_API_KEY`) hoặc OAuth/ambient discovery của provider khi profile không khai credential (`dsh-llm/lib/types/api-key.d.ts`).
- `initializeDefaultModel()` trong `dsh-api-session-controller` lưu model account khả dụng đầu tiên **after login** khi chưa provider nào có API key — tức có flow login tài khoản first-party ngoài API key.
- Failure codes phân biệt rõ: `MISSING_CREDENTIAL`, `INVALID_CREDENTIAL`, `AUTH`, `ACCOUNT_QUOTA`.

## 3. Outbound network (dsh-http-proxy)

- Launcher resolve + install policy từ env **trước khi plugin nào load**: `http_proxy`, `https_proxy`, `no_proxy`, `all_proxy` (lowercase trước; `ALL_PROXY` cấp cả hai scheme; HTTPS thiếu → rơi về HTTP proxy). Env thật → `$DSH_HOME/.env`. `.env` của project không được phép chứa các biến này — launcher từ chối start.
- Cơ chế: thay undici global dispatcher → mọi `fetch()` host-side (LLM, web-search, HTTP MCP) qua proxy. `new Agent()` tự truyền dispatcher là bypass ngầm — upstream có gate `verify-no-bare-dispatcher`.
- **Authenticated proxy**: qua userinfo trong URL — `HTTPS_PROXY=http://user:password@host:port` (undici `ProxyAgent` tự phát `Proxy-Authorization`). Không có NTLM/Kerberos hook.
- Loopback (`localhost`, `127.0.0.0/8`, `::1`, `0.0.0.0`) luôn bypass.
- Child process: `dsh-subprocess` phủ `proxyEnvironmentForChild()` — giữ nguyên giá trị user export, bơm giá trị resolved cho scheme chưa khai, thêm `NODE_USE_ENV_PROXY=1` (Node ≥22.21/24). SOCKS bị từ chối cho DSH nhưng vẫn giữ nguyên cho child (curl dùng được), kèm việc withhold flag để Node child không crash.
- Giới hạn: không SOCKS/PAC/system-proxy; TLS-intercept cần `NODE_EXTRA_CA_CERTS`; telemetry (`node:http`) đi direct; **model-authored code (ptc-runtime, workflow worker) cố tình không nhận proxy URL** vì nó có thể chứa credentials.

## 4. dsh-superagent panel: không dùng cookie auth

`src/app/http.ts` (`registerHttp` + `sameOrigin`):

- Route mount qua `ctx.webServer.register({ kind: 'prefix', path: '/orchestrator' })` — webserver không auth, nên chỉ `sameOrigin()` bảo vệ `/orchestrator/api/*`:
  - `Host` phải là `127.0.0.1:<port>` hoặc `localhost:<port>`;
  - bắt buộc header `x-orchestrator-request: 1` (do `src/client/api.ts` gắn — CSRF fence, vì cross-site form/fetch không set được custom header);
  - `Origin` nếu có phải là `http://<host>`.
- Hệ quả: **bất kỳ process local nào** cũng gọi được management API với header giả đúng — không có credential. Threat model là loopback-only (`registerHttp` throw nếu `webServer.host !== '127.0.0.1'`).
- Panel page được serve trong cùng DSH web app nên người dùng vẫn phải qua cookie auth của Connection để *load trang*; nhưng `/orchestrator/api/*` tự nó không kiểm tra cookie đó.

## Implications cho repo này

- Worker spawn env (`src/infra/environment.ts`) strip ambient GitHub tokens — proxy env đã được `dsh-subprocess` lo; nếu code nào tự build env cho spawn khác (git, scripts) cần kiểm tra nó có giữ `HTTP(S)_PROXY`/`NO_PROXY`.
- Panel management API là trust-boundary mỏng: an toàn miễn là webserver giữ loopback. Nếu ai bind `0.0.0.0` để truy cập remote, `registerHttp` sẽ throw — đúng thiết kế; đừng vá bằng cách nới check.
- Nếu cần "đăng nhập" thật cho panel (multi-user, remote access): DSH không cung cấp — phải tự implement trên route layer hoặc đặt sau authenticated reverse proxy, đồng thời mở `trustedHosts` phía Connection.

## Open questions

- Flow login first-party "after login" trong session-controller là OAuth của DeepSeek account hay provider-specific (pi-ai)? Chưa đọc sâu adapter code (`dsh-llm-pi-ai` chưa có trong dep tree của repo này).
- Cookie `browser-session` sống sót qua restart bao lâu: secret persist trong `.credentials.yaml`, TTL 30 ngày — nghĩa là cookie cũ vẫn valid sau restart (chỉ launch token mới thay đổi). Cần xác nhận nếu viết docs cho user.
