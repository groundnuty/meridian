import { object, rows, text, number } from './core'
import type { DesktopState, Action } from './contracts'
const pages = ['Overview', 'Usage & accounts', 'Requests', 'Logs', 'Service', 'Versions', 'Plugins', 'Settings'] as const
type Page = typeof pages[number]
const symbols = ['◉', '◷', '⇄', '≡', '◈', '↓', '◇', '⚙']
let page: Page = 'Overview'
let state: DesktopState | undefined
let filter = ''
const el = (id: string) => { const element = document.getElementById(id); if (!element) throw new Error(`Missing ${id}`); return element }
const esc = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] ?? char)
const count = (value: unknown) => number(value)?.toLocaleString(undefined, { maximumFractionDigits: 1 }) ?? '—'
const pct = (value: unknown) => number(value) === undefined ? '—' : `${Math.round(Number(value) * 100)}%`
const time = (value: unknown) => number(value) ? new Date(Number(value)).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—'
const duration = (value: unknown) => number(value) === undefined ? '—' : `${(Number(value) / 1000).toFixed(1)}s`
const empty = (title: string, detail: string) => `<div class="empty"><strong>${esc(title)}</strong><p>${esc(detail)}</p></div>`
function section(title: string, caption: string, content: string, extra = '') {
  return `<section ${extra}><div class="section-heading"><div><h2>${esc(title)}</h2>${caption ? `<p>${esc(caption)}</p>` : ''}</div></div>${content}</section>`
}
const button = (action: Action, label: string, value = '', disabled = false) => `<button data-action="${action}" data-value="${esc(value)}" ${disabled || state?.busy ? 'disabled' : ''}>${esc(label)}</button>`
function navigate(next: Page) { page = next; filter = ''; el('content').replaceChildren(); renderNav(); renderContent(); el('page-title').textContent = page }
function renderNav() {
  const nav = document.querySelector('nav'); if (!nav) return
  nav.innerHTML = pages.map((name, index) => `<button data-page="${esc(name)}" ${page === name ? 'aria-current="page"' : ''}><span aria-hidden="true">${symbols[index]}</span>${esc(name)}${name === 'Logs' && state?.incidents.length ? `<b>${state.incidents.length}</b>` : ''}</button>`).join('')
  nav.querySelectorAll<HTMLButtonElement>('button').forEach(button => button.onclick = () => { const selected = pages.find(name => name === button.dataset.page); if (selected) navigate(selected) })
}
async function action(name: Action, value?: unknown) {
  try { update(await window.meridian.action(name, value)); el('content').replaceChildren(); renderContent(); renderNav() }
  catch (error) { el('notice').textContent = error instanceof Error ? error.message : String(error); el('notice').className = 'notice error' }
}
function update(next: DesktopState) {
  state = next
  document.documentElement.classList.toggle('native-glass', next.glass === 'Native Liquid Glass')
  el('material').textContent = next.glass
  const online = Boolean(next.running)
  el('connection-dot').className = `dot ${online ? 'healthy' : ''}`
  el('connection-name').textContent = online ? next.owned ? 'Running · app managed' : 'Connected · external service' : next.preferences.mode === 'managed' ? 'Managed service stopped' : 'Not connected'
  el('connection-address').textContent = (next.preferences.mode === 'managed' ? `127.0.0.1:${next.preferences.port}` : next.preferences.endpoint.replace('http://', ''))
  el('last-checked').textContent = next.busy ? next.busy + '…' : next.lastChecked ? `Updated ${time(next.lastChecked)}` : 'Waiting for Meridian'
  el('version').textContent = next.running ? `Meridian ${next.running}` : `Desktop ${next.desktopVersion}`
  el('refresh').toggleAttribute('disabled', Boolean(next.busy))
  el('notice').textContent = next.error || (next.dataErrors.length && !(next.preferences.mode === 'managed' && !next.owned && !next.busy) ? (online ? `${next.dataErrors.length} data source(s) unavailable. Check the connection and API key in Settings.` : 'No Meridian connection yet. Open Settings to connect your existing service.') : '')
  el('notice').className = el('notice').textContent ? 'notice' : ''
  // Preserve editing focus across background polling. Explicit navigation and
  // completed actions rebuild the content, so settings can still reflect saves.
  if (!el('content').contains(document.activeElement) || !document.activeElement?.matches('input, select, textarea')) renderContent()
  const footer = document.querySelector('footer > span'); if (footer) footer.textContent = next.preferences.mode === 'managed' ? next.owned ? 'App managed · closing this window keeps Meridian running' : 'App-managed installation · service stopped' : 'Connected services keep their existing supervisor'
}
function stats() {
  const summary = object(state?.summary)
  const tokens = object(summary.tokenUsage)
  const populated = Number(summary.totalRequests) > 0
  const windowLabel = number(summary.windowMs) ? `Last ${Math.round(Number(summary.windowMs) / 60000)} minutes` : 'In this telemetry window'
  return `<div class="stats">${[
    ['Requests', count(summary.totalRequests), windowLabel],
    ['Cache reuse', populated ? pct(tokens.avgCacheHitRate) : '—', 'Average input cache hit rate'],
    ['First token', populated ? duration(object(summary.ttfb).p50) : '—', 'Median response time'],
    ['Errors', count(summary.errorCount), 'Failed requests'],
  ].map(([label, value, note]) => `<div><span class="eyebrow">${label}</span><strong>${value}</strong><small>${note}</small></div>`).join('')}</div>`
}
function quotas(limit = 100) {
  const profiles = rows(object(state?.quota).profiles).slice(0, limit)
  if (!profiles.length) return empty('Usage limits are not available yet', 'Connect an authenticated Meridian service to see account limits and reset times.')
  return `<div class="quota-list">${profiles.map(profile => `<article class="account"><div class="account-head"><div class="avatar">${esc((text(profile.id) || 'M').slice(0, 1).toUpperCase())}</div><div><strong>${esc(profile.id)}</strong><small>${profile.error ? esc(profile.error) : `Last checked ${time(profile.fetchedAt)}`}</small></div></div>${rows(profile.windows).map(window => {
    const value = number(window.utilization)
    const clamped = Math.max(0, Math.min(1, value ?? 0))
    const reset = number(window.resetsAt)
    const resetText = reset ? (reset > Date.now() ? `Resets ${new Date(reset).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })}` : 'Reset time passed · awaiting refresh') : 'Reset time unavailable'
    return `<div class="quota"><div><span>${esc(text(window.type).replaceAll('_', ' '))}</span><strong>${pct(value)}</strong></div><progress class="${clamped >= .85 ? 'danger' : clamped >= .6 ? 'warning' : ''}" max="1" value="${clamped}" aria-label="${esc(window.type)} usage"></progress><small>${esc(resetText)}${number(profile.fetchedAt) && Date.now() - Number(profile.fetchedAt) > 90000 ? ' · Stale reading' : ''}</small></div>`
  }).join('') || '<p class="muted">No quota windows reported.</p>'}</article>`).join('')}</div>`
}
function requestTable(limit: number) {
  const records = rows(state?.requests).filter(row => !filter || JSON.stringify(row).toLowerCase().includes(filter.toLowerCase())).sort((a, b) => Number(b.timestamp) - Number(a.timestamp)).slice(0, limit)
  if (!records.length) return empty('No requests to show', filter ? 'Try another model, profile, or request ID.' : 'Requests will appear here when a client sends traffic through the connected Meridian service.')
  return `<div class="table-wrap"><table><thead><tr><th>Time</th><th>Model / request</th><th>Profile</th><th>Cache</th><th>Duration</th><th>Status</th></tr></thead><tbody>${records.map(row => `<tr><td class="muted mono">${time(row.timestamp)}</td><td><strong>${esc(row.model || 'Unknown model')}</strong><small class="mono">${esc(text(row.requestId).slice(0, 22))}</small></td><td>${esc(row.profileId || 'default')}</td><td class="mono">${pct(row.cacheHitRate)}</td><td class="mono">${duration(row.totalDurationMs)}</td><td><span class="status ${Number(row.status) >= 400 ? 'bad' : 'good'}">${esc(row.status || '—')}</span></td></tr>`).join('')}</tbody></table></div>`
}
function activity() {
  const requests = rows(state?.requests).sort((a, b) => Number(a.timestamp) - Number(b.timestamp)).slice(-48)
  if (!requests.length) return empty('Ready for your next request', 'The cache history will fill in as Meridian handles your conversations.')
  return `<svg class="cache-chart" viewBox="0 0 480 120" preserveAspectRatio="none" role="img" aria-label="Cache reuse for the most recent requests">${requests.map((row, index) => {
    const width = 480 / requests.length
    const height = Math.max(1, Math.min(1, number(row.cacheHitRate) ?? 0) * 112)
    return `<rect class="cache-track" x="${index * width}" y="8" width="${width - 3}" height="112" rx="2"/><rect class="cache-bar" x="${index * width}" y="${120 - height}" width="${width - 3}" height="${height}" rx="2"><title>${esc(row.requestId)} · ${pct(row.cacheHitRate)} cache reuse</title></rect>`
  }).join('')}</svg><div class="chart-caption"><span>Earlier requests</span><span>Latest · ${requests.length} requests</span></div>`
}
function renderContent() {
  const current = state
  if (!current) { el('content').innerHTML = empty('Connecting to Meridian', 'Reading service health and telemetry…'); return }
  const health = object(current.health)
  let html = ''
  if (page === 'Overview') {
    html = `<div class="hero"><div><div class="live-label"><i class="dot ${current.running ? 'healthy' : ''}"></i>${current.running ? 'LIVE CONNECTION' : current.preferences.mode === 'managed' ? 'SERVICE STOPPED' : 'AWAITING CONNECTION'}</div><h2>${current.running ? 'Your local Claude, at a glance.' : current.preferences.mode === 'managed' ? 'Meridian is stopped.' : 'A home for your Meridian.'}</h2><p>${current.running ? 'Usage, cache health, and every request. Your service and its current owner are always visible.' : current.preferences.mode === 'managed' ? 'Start the selected version from Service. Your installation and settings are retained.' : 'Connect your existing setup to see its health, limits, and activity in one place.'}</p></div><div class="hero-meta"><span class="eyebrow">SERVICE OWNER</span><strong>${current.owned || (!current.running && current.preferences.mode === 'managed') ? 'Meridian Desktop' : 'External'}</strong><small>${current.preferences.mode === 'managed' ? 'Managed installation on this Mac' : 'Docker · Nix · CLI · service manager'}</small></div></div>${stats()}<div class="overview-grid">${section('Cache continuity', 'Reuse across the latest conversations', activity())}${section('Service details', '', `<dl><div><dt>Connection</dt><dd>${current.running ? 'Connected' : 'Offline'}</dd></div><div><dt>Health</dt><dd>${esc(health.status || 'Unavailable')}</dd></div><div><dt>Version</dt><dd class="mono">${esc(current.running || '—')}</dd></div><div><dt>Profiles</dt><dd>${count(rows(object(current.profiles).profiles).length)}</dd></div><div><dt>Management</dt><dd>${current.preferences.mode === 'managed' ? current.owned ? 'App managed' : 'App managed · stopped' : 'Connect only'}</dd></div></dl>`)}</div>${section('Usage limits', 'Headroom and reset times, by account', quotas(2))}${section('Recent requests', 'The latest activity through your connected service', requestTable(5))}`
  } else if (page === 'Usage & accounts') {
    html = section('Your usage limits', 'Live account windows. Missing or stale data is never treated as unused quota.', quotas()) + section('Connected profiles', 'Profiles belong to your existing Meridian configuration.', `<div class="profile-list">${rows(object(current.profiles).profiles).map(profile => `<div class="profile-row"><div class="avatar">${esc(text(profile.id).slice(0, 1).toUpperCase())}</div><div><strong>${esc(profile.id)}</strong><small>${esc(profile.email || 'Email unavailable')}</small></div><span class="status ${profile.loggedIn ? 'good' : ''}">${profile.loggedIn ? 'Signed in' : 'Not signed in'}</span>${object(current?.profiles).activeProfile === profile.id ? '<span class="status active">Active</span>' : ''}</div>`).join('') || empty('No profiles returned', 'Check your connection and authentication in Settings.')}</div>`)
  } else if (page === 'Requests') {
    html = `<div class="search-row"><input id="filter" type="search" placeholder="Filter by model, profile, or request ID" aria-label="Filter requests" value="${esc(filter)}"><span class="muted">Up to 500 recent requests</span></div><div id="results">${requestTable(500)}</div>`
  } else if (page === 'Logs') {
    html = section('Needs attention', 'New request failures, cache misses, and usage thresholds observed by the app.', current.incidents.length ? button('acknowledge', 'Clear observed alerts') + current.incidents.map(item => `<div class="incident"><span class="status ${item.severity === 'error' ? 'bad' : ''}">${esc(item.severity)}</span><div><strong>${esc(item.title)}</strong><p>${esc(item.detail)}</p></div><small>${time(item.timestamp)}</small></div>`).join('') : empty('No alerts observed', 'New request failures and repeated cache misses will appear here.')) + section('Diagnostic stream', 'Recent events from the connected service', `<div class="log-view">${rows(current.logs).slice(-150).reverse().map(log => `<div><time>${time(log.timestamp)}</time><span class="log-kind">${esc(log.category || log.level || 'event')}</span><span>${esc(log.message || JSON.stringify(log))}</span></div>`).join('') || '<p class="muted">No diagnostic events returned.</p>'}</div>`)
    html += section('Service output', 'Installer output and managed-process stdout/stderr', `<pre class="service-output">${esc(current.serviceLog.join('\n') || 'No managed service output yet.')}</pre>` )
  } else if (page === 'Service') {
    const managed = current.preferences.mode === 'managed'
    html = `<div class="version-hero"><img src="icon.png" alt=""><div><span class="eyebrow">SERVICE OWNERSHIP</span><h2>${current.owned ? 'Running under Meridian Desktop' : managed ? 'Ready for app management' : 'Connected to your existing service'}</h2><p>${managed ? 'The app supervises the selected Meridian installation.' : 'Your current supervisor keeps control of this service.'}</p></div></div>` + section('Process', '', `<div class="setting-row"><div><strong>${current.owned ? 'Meridian is running' : managed ? 'Meridian is stopped' : 'Externally managed'}</strong><p>${managed ? `Local endpoint: http://127.0.0.1:${current.preferences.port}` : esc(current.preferences.endpoint)}</p></div><div class="button-group">${button('start', 'Start', '', !managed || current.owned || !current.preferences.selected)}${button('restart', 'Restart', '', !current.owned)}${button('stop', 'Stop', '', !current.owned)}</div></div><dl><div><dt>Selected version</dt><dd>${esc(current.preferences.selected || 'Install a version first')}</dd></div><div><dt>Restart on crash</dt><dd>Up to 3 attempts; pauses on repeated failure</dd></div><div><dt>When this window closes</dt><dd>Meridian keeps running in the menu bar</dd></div><div><dt>When the app quits</dt><dd>Owned requests drain before shutdown</dd></div></dl>`)
    html += section('Choose how to run Meridian', 'Connecting never changes an external installation. App-managed startup refuses an occupied port.', `<form id="service-form"><label>Service mode<select name="mode"><option value="attached" ${!managed ? 'selected' : ''}>Connect to an existing service</option><option value="managed" ${managed ? 'selected' : ''}>App-managed installation</option></select></label><label>App-managed port<input name="port" type="number" min="1024" max="65535" value="${current.preferences.port}" required></label><button type="submit" ${current.owned || current.busy ? 'disabled' : ''}>Save service mode</button></form><div class="explanation"><strong>Moving an existing service?</strong><p>Automatic handoff is still being verified. Until it is enabled, keep the existing service connected, or stop its supervisor yourself before choosing app management on the same port. Configuration and Claude credentials remain in their existing locations.</p></div>`)
  } else if (page === 'Versions') {
    html = `<div class="version-hero"><img src="icon.png" alt=""><div><span class="eyebrow">CONNECTED MERIDIAN</span><h2>${esc(current.running || 'Not running')}</h2><p>${current.preferences.mode === 'managed' ? 'Managed by Meridian Desktop' : 'External installations keep their own package manager'}</p></div><span class="status active">${current.preferences.mode === 'managed' ? 'App managed' : 'External service'}</span></div>`
    html += section('Available releases', 'Install a separate copy for app management. Downloads never replace an external installation.', `<div class="setting-row"><div><strong>Latest stable release</strong><p>${esc(current.latest || 'Check the npm registry for available versions.')}</p></div>${button('check-updates', 'Check for updates')}</div>${current.available.length ? `<form id="install-form" class="inline-form"><label>Version<select name="version">${current.available.map(release => `<option value="${esc(release)}">${esc(release)}${release === current.latest ? ' · Latest' : ''}</option>`).join('')}</select></label><button type="submit" ${current.busy ? 'disabled' : ''}>Install for app</button></form>` : ''}`)
    html += section('Installed for the app', 'Versions stay pinned until you select another. A failed activation restores the previous working selection.', current.installed.length ? current.installed.map(release => `<div class="setting-row"><div><strong class="mono">${esc(release)}</strong><p>${release === current.preferences.selected ? 'Selected' : release === current.preferences.previous ? 'Previous version · available for rollback' : 'Ready to activate'}</p></div>${button('release-notes', 'Release notes', release)}${button('activate', release === current.preferences.previous ? 'Roll back' : 'Use version', release, release === current.preferences.selected || current.preferences.mode !== 'managed')}</div>`).join('') : empty('No app-managed version installed', 'Check for releases and install a version to get started.'))
  } else if (page === 'Plugins') {
    html = section('Loaded plugins', 'Plugins reported by the connected service.', button('reload-plugins', 'Reload plugins', '', !current.running) + rows(object(current.plugins).plugins).map(plugin => `<div class="setting-row"><div><strong>${esc(plugin.name)}</strong><p>${esc(plugin.description)}</p><small>${esc(plugin.error || plugin.version || '')}</small></div><span class="status ${plugin.status === 'active' ? 'good' : 'bad'}">${esc(plugin.status)}</span></div>`).join(''))

  } else {
    html = section('Connection', 'Connect to Meridian running locally, including a Docker port exposed on this Mac.', `<form id="connection-form"><label>Meridian address<input name="endpoint" type="url" required value="${esc(current.preferences.endpoint)}" spellcheck="false"></label><label>API key <span class="muted">${current.hasApiKey ? '(saved · leave blank to keep)' : '(if required)'}</span><input name="apiKey" type="password" autocomplete="off" placeholder="${current.hasApiKey ? 'Key saved securely' : 'Optional'}"></label><div class="form-actions"><button type="submit">Connect to Meridian</button><span class="muted">Connection only · keeps your service running</span></div></form>`) + section('About Meridian Desktop', 'Optional desktop management for your local Meridian.', `<dl><div><dt>Appearance</dt><dd>${esc(current.glass)}</dd></div><div><dt>Desktop version</dt><dd>${esc(current.desktopVersion)}</dd></div><div><dt>Platform</dt><dd>${esc(current.platform)}</dd></div><div><dt>Refresh interval</dt><dd>10 seconds</dd></div></dl><div class="explanation"><p>Managed installation, version switching, background supervision, and notifications are available. Automatic handoff of an existing supervisor is still under verification.</p></div>`)
  }
  if (page === 'Settings') {
    html += section('Background & notifications', 'Choose what happens when you open the app and when new incidents appear.', `<form id="preferences-form"><label class="check"><input name="autoStart" type="checkbox" ${current.preferences.autoStart ? 'checked' : ''}> Start managed Meridian when the app opens</label><label class="check"><input name="notifications" type="checkbox" ${current.preferences.notifications ? 'checked' : ''}> Notify me about new failures and usage thresholds</label><button type="submit">Save preferences</button></form><div class="setting-row"><div><strong>Open at login</strong><p>Launch the packaged app when you sign into this Mac.</p></div>${button('login-at-startup', current.loginAtStartup ? 'Disable' : 'Enable', current.loginAtStartup ? 'false' : 'true', current.platform !== 'darwin')}</div><div class="setting-row"><div><strong>Diagnostic summary</strong><p>Export aggregate counts and timings. Raw prompts and logs are excluded.</p></div>${button('export-diagnostics', 'Export summary')}</div>`)
    html += section('Client features', 'Updates apply to the connected Meridian service and affect subsequent requests.', Object.entries(object(current.features)).map(([adapter, features]) => `<details><summary>${esc(adapter)}</summary><form class="features-form" data-adapter="${esc(adapter)}">${Object.entries(object(features)).filter(([, value]) => typeof value === 'boolean').map(([key, value]) => `<label class="check"><input type="checkbox" name="${esc(key)}" ${value ? 'checked' : ''}> ${esc(key.replace(/([A-Z])/g, ' $1'))}</label>`).join('')}<button type="submit">Save client features</button></form></details>`).join(''))
  }
  if (page === 'Usage & accounts') {
    html += section('Manage profiles', 'Profile switching affects the connected service. Sign-in uses the selected app-managed CLI.', `<div class="button-group">${rows(object(current.profiles).profiles).map(profile => button('switch-profile', `Use ${text(profile.id)}`, text(profile.id), text(profile.id) === text(object(current?.profiles).activeProfile))).join('')}</div>${current.preferences.mode === 'managed' ? `<form id="profile-form" class="inline-form"><label>Profile name<input name="profile" pattern="[a-zA-Z0-9_-]{1,64}" required></label><button name="operation" value="add-profile" type="submit">Add account</button><button name="operation" value="login-profile" type="submit">Sign in again</button></form>` : ''}`)
  }
  if (current.login) html = `<section class="login-panel"><h2>Sign in to Claude</h2><pre class="service-output">${esc(current.login.output)}</pre>${button('open-login', 'Open Claude sign-in', '', !current.login.url)}<form id="login-form"><label>Authorization code<input name="code" autocomplete="off" required></label><button type="submit">Complete sign-in</button></form>${button('login-code', 'Cancel sign-in', 'cancel')}</section>` + html
  const drafts = new Map<string, {value: string; checked: boolean}>()
  el('content').querySelectorAll<HTMLInputElement | HTMLSelectElement>('input[name], select[name]').forEach(field => {
    const key = (field.form?.id || field.form?.dataset.adapter || '') + ':' + field.name
    drafts.set(key, {value: field.value, checked: field instanceof HTMLInputElement && field.checked})
  })
  el('content').innerHTML = html
  el('content').querySelectorAll<HTMLInputElement | HTMLSelectElement>('input[name], select[name]').forEach(field => {
    const key = (field.form?.id || field.form?.dataset.adapter || '') + ':' + field.name
    const draft = drafts.get(key)
    if (draft) { field.value = draft.value; if (field instanceof HTMLInputElement) field.checked = draft.checked }
  })
  document.getElementById('check-updates')?.addEventListener('click', () => { void action('check-updates') })
  const search = document.getElementById('filter')
  if (search instanceof HTMLInputElement) search.oninput = () => { filter = search.value; el('results').innerHTML = requestTable(500) }
  el('content').querySelectorAll<HTMLButtonElement>('button[data-action]').forEach(control => control.onclick = () => {
    const name = control.dataset.action as Action
    const value = name === 'login-at-startup' ? control.dataset.value === 'true' : control.dataset.value
    void action(name, value)
  })
  const bindForm = (id: string, handler: (data: FormData, event: SubmitEvent) => void) => {
    const form = document.getElementById(id)
    if (form instanceof HTMLFormElement) form.onsubmit = event => { event.preventDefault(); handler(new FormData(form), event) }
  }
  bindForm('service-form', data => { void action('save-preferences', { mode: data.get('mode'), port: Number(data.get('port')) }) })
  bindForm('install-form', data => { void action('install', data.get('version')) })
  bindForm('preferences-form', data => { void action('save-preferences', { autoStart: data.has('autoStart'), notifications: data.has('notifications') }) })
  bindForm('login-form', data => { void action('login-code', data.get('code')) })
  bindForm('profile-form', (data, event) => { const operation = event.submitter instanceof HTMLButtonElement && event.submitter.value === 'login-profile' ? 'login-profile' : 'add-profile'; void action(operation, data.get('profile')) })
  el('content').querySelectorAll<HTMLFormElement>('.features-form').forEach(form => form.onsubmit = event => {
    event.preventDefault()
    const fields = [...form.querySelectorAll<HTMLInputElement>('input[type=checkbox]')]
    void action('set-features', { adapter: form.dataset.adapter, features: Object.fromEntries(fields.map(field => [field.name, field.checked])) })
  })
  const form = document.getElementById('connection-form')
  if (form instanceof HTMLFormElement) form.onsubmit = event => {
    event.preventDefault(); const data = new FormData(form); const key = String(data.get('apiKey') || '')
    void action('save-preferences', { mode: 'attached', endpoint: data.get('endpoint'), ...(key ? { apiKey: key } : {}) })
  }
}
el('refresh').onclick = () => { void action('refresh') }
renderNav(); renderContent()
window.meridian.subscribe(update)
void window.meridian.state().then(update).catch(error => { el('notice').textContent = String(error) })
