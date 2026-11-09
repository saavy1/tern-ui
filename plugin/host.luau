--!strict
-- tern-ui, host half: the `view` block. It draws a .ternui spec written by the
-- tern-ui MCP server on this machine, redraws when the file changes, and records
-- clicks for the server to read.
--
-- Files, all next to each other:
--   NAME.ternui         {v, title, view, waiting?}   the spec (rewritten whole to update)
--   NAME.ternui.events  one JSON event per line        written here, read by the server
--   NAME.ternui.pane    this block's pane id            so the server knows it is open

local POLL_MS = 250
local MAX_SPEC = 1024 * 1024
local MAX_IMAGE = 8 * 1024 * 1024

type Spec = { v: number?, title: string?, view: any?, waiting: boolean?, owner: number? }

local function encode(s: string): string
	return (string.gsub(s, "[^%w%-%._~]", function(c: string): string
		return string.format("%%%02X", string.byte(c))
	end))
end

-- Sends `text` into chat `pane` (through the window's link route, see window.luau).
local function ask(cx: EffectCx, pane: number?, text: string)
	if pane then
		cx:open("tern-ui:ask?pane=" .. tostring(pane) .. "&text=" .. encode(text))
	end
end
type State = { path: string, raw: string, spec: Spec?, err: string?, answered: string? }

-- Live block contexts by pane, for redraws from the poll timer.
local live: { [number]: { cx: BlockCx, s: State } } = {}

local MIME = { png = "image/png", jpg = "image/jpeg", jpeg = "image/jpeg", gif = "image/gif", webp = "image/webp", svg = "image/svg+xml" }

-- Image nodes name a file (`p.path`); Tern draws blobs, so hand it the bytes.
local function resolveImages(node: any, cx: BlockCx)
	if type(node) ~= "table" then
		return
	end
	local p = node.p
	if node.k == "image" and type(p) == "table" and type(p.path) == "string" then
		local ext = string.lower(string.match(p.path, "%.([%w]+)$") or "")
		local ok, bytes = pcall(tern.fs.read, p.path, MAX_IMAGE)
		if ok and MIME[ext] then
			p.blob = cx:blob(bytes, MIME[ext])
		end
		p.path = nil
	end
	if type(node.c) == "table" then
		for _, child in node.c do
			resolveImages(child, cx)
		end
	end
end

-- Reads the spec again; true when it changed.
local function load(s: State, cx: BlockCx): boolean
	local ok, raw = pcall(tern.fs.read, s.path, MAX_SPEC)
	if not ok then
		if s.err == nil then
			s.err = "Can't read " .. s.path
			return true
		end
		return false
	end
	if raw == s.raw then
		return false
	end
	s.raw = raw
	local decoded, spec = pcall(tern.json.decode, raw)
	if decoded and type(spec) == "table" then
		resolveImages(spec.view, cx)
		s.spec = spec
		s.err = nil
		s.answered = nil
	else
		s.err = "The spec isn't valid JSON"
	end
	return true
end

local function poll(pane: number)
	tern.timer(POLL_MS, function()
		local entry = live[pane]
		if entry == nil then
			return
		end
		local ok, changed = pcall(load, entry.s, entry.cx)
		if ok and changed then
			-- A closed block can't render: forget it.
			if not pcall(function()
				entry.cx:render()
			end) then
				live[pane] = nil
				return
			end
		end
		poll(pane)
	end)
end

-- Appends one event line for the server (tern.fs has no append; the file stays small).
local function record(s: State, event: { [string]: any }): boolean
	local path = s.path .. ".events"
	local prior = ""
	if tern.fs.exists(path) then
		prior = tern.fs.read(path, MAX_SPEC)
	end
	tern.fs.write(path, prior .. tern.json.encode(event) .. "\n")
	return true
end

tern.block.define("view", {
	init = function(cx: BlockCx, args: { string }, saved: any): State
		local path = args[1] or (type(saved) == "table" and saved.path) or ""
		local s: State = { path = path, raw = "" }
		load(s, cx)
		pcall(tern.fs.write, path .. ".pane", tostring(cx.pane))
		live[cx.pane] = { cx = cx, s = s }
		poll(cx.pane)
		return s
	end,

	view = function(s: State, _cx: BlockCx): BlockView
		local children = {}
		if s.err then
			table.insert(children, tern.ui.text(tern.ui.span(s.err, "error")))
		end
		if s.spec and s.spec.view then
			table.insert(children, s.spec.view)
		end
		if s.answered then
			table.insert(children, tern.ui.text(tern.ui.span("Sent: " .. s.answered, "muted")))
		end
		return { main = { k = "col", p = { key = "root", gap = "md" }, c = children } }
	end,

	title = function(s: State): string?
		return (s.spec and s.spec.title) or "Agent UI"
	end,

	event = function(s: State, ev: UiEvent, cx: BlockCx)
		if ev.ev ~= "action" and ev.ev ~= "select" and ev.ev ~= "activate" and ev.ev ~= "change" then
			return
		end
		local event = {
			ev = ev.ev,
			act = ev.act,
			value = ev.value,
			id = ev.id,
			item = ev.item,
			name = ev.name,
			checked = ev.checked,
			values = ev.values,
			at = tern.now(),
		}
		local ok, err = pcall(record, s, event)
		if not ok then
			cx:toast("error", "tern-ui couldn't record that", tostring(err))
		elseif ev.ev ~= "change" and s.spec then
			local what = tostring(ev.act or ev.item or ev.ev)
			if s.spec.waiting then
				-- The agent is waiting on this: the server hands the click back as the tool result.
				s.answered = what
			elseif s.spec.owner then
				-- Nobody waits: tell the chat that owns this UI.
				local handle = string.match(s.path, "([^/]+)%.ternui$") or "ui"
				local values = (ev.values and next(ev.values)) and (" " .. tern.json.encode(ev.values)) or ""
				ask(cx, s.spec.owner, "[ui " .. handle .. "] " .. what .. " on " .. tostring(ev.id or "?") .. values)
				s.answered = what
			end
		end
	end,

	save = function(s: State): any
		return { path = s.path }
	end,
})

-- ─── github: a session's pull requests, kept live ───────────────────────────
--
-- NAME.ternprs: {owner: chat pane, repos: {dir}, prs: {{repo, number}}}, written
-- by the server's track_pr. The block shows the PR of each repo dir's current
-- branch plus every tracked PR, refreshed with `gh` on this machine.

local REFRESH_MS = 45000
local PR_FIELDS = "number,title,url,state,isDraft,headRefName,reviewDecision,mergeable,statusCheckRollup,reviews,comments"

type Tracked = { owner: number?, repos: { string }?, prs: { { repo: string, number: number } }? }
type Check = { name: string, state: string, run: string?, url: string? }
type Pr = { key: string, repo: string, data: any, checks: { Check } }
type GhState = {
	path: string,
	raw: string,
	tracked: Tracked,
	prs: { [string]: Pr },
	order: { string },
	errors: { string },
	updated: number?,
	busy: number,
	note: string?,
}

local hub: { [number]: { cx: BlockCx, s: GhState, due: number } } = {}

local function checksOf(rollup: any): { Check }
	local out: { Check } = {}
	if type(rollup) ~= "table" then
		return out
	end
	for _, c in rollup do
		local name = c.name or c.context or "check"
		if c.workflowName and c.workflowName ~= "" and c.workflowName ~= name then
			name = c.workflowName .. " / " .. name
		end
		local raw = string.upper(tostring(c.conclusion or c.state or c.status or ""))
		local state = "pending"
		if raw == "SUCCESS" or raw == "NEUTRAL" or raw == "SKIPPED" then
			state = "pass"
		elseif raw == "FAILURE" or raw == "ERROR" or raw == "TIMED_OUT" or raw == "CANCELLED" or raw == "ACTION_REQUIRED" or raw == "STARTUP_FAILURE" then
			state = "fail"
		end
		local url = c.detailsUrl or c.targetUrl
		local run = url and string.match(url, "/actions/runs/(%d+)") or nil
		table.insert(out, { name = name, state = state, run = run, url = url })
	end
	table.sort(out, function(a: Check, b: Check): boolean
		local rank = { fail = 0, pending = 1, pass = 2 }
		if rank[a.state] ~= rank[b.state] then
			return rank[a.state] < rank[b.state]
		end
		return a.name < b.name
	end)
	return out
end

local function repoOf(url: string?): string
	return url and string.match(url, "github%.com/([^/]+/[^/]+)/pull/") or "?"
end

local function loadTracked(s: GhState): boolean
	local ok, raw = pcall(tern.fs.read, s.path, 65536)
	if not ok or raw == s.raw then
		return false
	end
	s.raw = raw
	local decoded, t = pcall(tern.json.decode, raw)
	s.tracked = (decoded and type(t) == "table") and t or {}
	return true
end

local function render(pane: number)
	local entry = hub[pane]
	if entry then
		pcall(function()
			entry.cx:render()
		end)
	end
end

-- Runs `gh pr view` for one target; `cwd` targets the PR of that checkout's branch.
local function fetch(pane: number, args: { string }, cwd: string?)
	local entry = hub[pane]
	if not entry then
		return
	end
	local s = entry.s
	s.busy += 1
	local argv = { "gh", "pr", "view" }
	for _, a in args do
		table.insert(argv, a)
	end
	table.insert(argv, "--json")
	table.insert(argv, PR_FIELDS)
	tern.process.run(argv, { cwd = cwd, timeout_ms = 20000 }, function(r: ProcessResult)
		s.busy -= 1
		if r.status == 0 then
			local ok, data = pcall(tern.json.decode, r.stdout)
			if ok and type(data) == "table" and data.url then
				local key = data.url
				if not s.prs[key] then
					table.insert(s.order, key)
				end
				s.prs[key] = { key = key, repo = repoOf(data.url), data = data, checks = checksOf(data.statusCheckRollup) }
			end
		elseif not cwd then
			table.insert(s.errors, table.concat(args, " ") .. ": " .. (string.match(r.stderr, "[^\n]+") or "gh failed"))
		end
		if s.busy == 0 then
			s.updated = tern.now()
			render(pane)
		end
	end)
end

local function refresh(pane: number)
	local entry = hub[pane]
	if not entry or entry.s.busy > 0 then
		return
	end
	local s = entry.s
	s.errors = {}
	entry.due = tern.now() + REFRESH_MS
	local t = s.tracked
	local repos: { string } = t.repos or {}
	local tracked: { { repo: string, number: number } } = t.prs or {}
	for _, dir in repos do
		fetch(pane, {}, dir)
	end
	for _, pr in tracked do
		fetch(pane, { tostring(pr.number), "-R", pr.repo }, nil)
	end
	if s.busy == 0 then
		s.updated = tern.now()
		render(pane)
	end
end

local function tick(pane: number)
	tern.timer(2000, function()
		local entry = hub[pane]
		if not entry then
			return
		end
		local changed = loadTracked(entry.s)
		if changed or tern.now() >= entry.due then
			refresh(pane)
		end
		tick(pane)
	end)
end

local ICON = { pass = { "✓", "success" }, fail = { "✗", "error" }, pending = { "●", "warning" } }

local function prCard(pr: Pr): any
	local d = pr.data
	local failing, pending, passing = 0, 0, 0
	for _, c in pr.checks do
		if c.state == "fail" then
			failing += 1
		elseif c.state == "pending" then
			pending += 1
		else
			passing += 1
		end
	end
	local badges = {}
	local stateTone = d.state == "MERGED" and "accent" or d.state == "CLOSED" and "muted" or (d.isDraft and "muted" or "info")
	table.insert(badges, tern.ui.badge(d.isDraft and "draft" or string.lower(tostring(d.state)), stateTone))
	if d.reviewDecision and d.reviewDecision ~= "" then
		local rd = string.lower((string.gsub(tostring(d.reviewDecision), "_", " ")))
		table.insert(badges, tern.ui.badge(rd, d.reviewDecision == "APPROVED" and "success" or d.reviewDecision == "CHANGES_REQUESTED" and "error" or "warning"))
	end
	if d.mergeable == "CONFLICTING" then
		table.insert(badges, tern.ui.badge("conflicts", "error"))
	end
	local summary = (failing > 0 and (failing .. " failing · ") or "") .. (pending > 0 and (pending .. " running · ") or "") .. passing .. " passing"
	table.insert(badges, tern.ui.text(tern.ui.span(summary, failing > 0 and "error" or pending > 0 and "warning" or "success")))

	local rows = {}
	for _, c in pr.checks do
		local icon = ICON[c.state]
		local name: Span = if c.url then tern.ui.link(c.name, c.url) else tern.ui.span(c.name)
		table.insert(rows, { tern.ui.span(icon[1], icon[2]), name })
	end
	local children: { any } = { tern.ui.row(badges) }
	if #rows > 0 then
		table.insert(children, tern.ui.table({ { id = "s", head = "" }, { id = "n", head = "Check", grow = 1, truncate = "end" } }, rows))
	end

	-- The latest few reviews and comments, newest last.
	local notes = {}
	for _, list in { d.reviews or {}, d.comments or {} } do
		for _, n in list do
			if type(n) == "table" and n.body and n.body ~= "" then
				table.insert(notes, n)
			end
		end
	end
	table.sort(notes, function(a: any, b: any): boolean
		return tostring(a.submittedAt or a.createdAt or "") < tostring(b.submittedAt or b.createdAt or "")
	end)
	for i = math.max(1, #notes - 1), #notes do
		local n = notes[i]
		if n then
			local who = (type(n.author) == "table" and n.author.login) or "someone"
			local body = string.gsub(string.sub(tostring(n.body), 1, 220), "%s+", " ")
			table.insert(children, tern.ui.text({ tern.ui.span(who .. ": ", "strong"), tern.ui.span(body, "muted") }))
		end
	end

	local actions = { tern.ui.button("Open", { actions = { click = "open=" .. pr.key } }) }
	if failing > 0 then
		table.insert(actions, tern.ui.button("Re-run failed", { actions = { click = "rerun=" .. pr.key } }))
		table.insert(actions, tern.ui.button("Send to agent", { variant = "primary", actions = { click = "send=" .. pr.key } }))
	end
	table.insert(children, tern.ui.row(actions))
	return tern.ui.card({ tern.ui.span("#" .. tostring(d.number) .. " ", "muted"), tern.ui.span(tostring(d.title), "strong") }, children, {
		meta = pr.repo .. " · " .. tostring(d.headRefName or ""),
		tone = failing > 0 and "error" or nil,
	})
end

local function failureText(pr: Pr): string
	local lines = { "PR #" .. tostring(pr.data.number) .. " (" .. pr.repo .. ", branch " .. tostring(pr.data.headRefName) .. ") has failing checks:" }
	for _, c in pr.checks do
		if c.state == "fail" then
			table.insert(lines, "- " .. c.name .. (c.url and (" " .. c.url) or ""))
		end
	end
	table.insert(lines, "Look at the failing runs (gh run view --log-failed), reproduce locally, fix, and confirm CI is green before saying done.")
	return table.concat(lines, "\n")
end

tern.block.define("github", {
	init = function(cx: BlockCx, args: { string }, saved: any): GhState
		local path = args[1] or (type(saved) == "table" and saved.path) or ""
		local s: GhState = { path = path, raw = "", tracked = {}, prs = {}, order = {}, errors = {}, busy = 0 }
		loadTracked(s)
		hub[cx.pane] = { cx = cx, s = s, due = 0 }
		pcall(tern.fs.write, path .. ".pane", tostring(cx.pane))
		tick(cx.pane)
		return s
	end,

	view = function(s: GhState, _cx: BlockCx): BlockView
		local children: { any } = {}
		local status = s.busy > 0 and "Refreshing…" or (s.updated and ("Updated " .. tostring(math.floor((tern.now() - s.updated) / 1000)) .. "s ago · every 45s") or "Loading…")
		table.insert(children, tern.ui.row({ tern.ui.text(tern.ui.span(status, "muted")), tern.ui.button("Refresh", { variant = "quiet", actions = { click = "refresh" } }) }))
		for _, e in s.errors do
			table.insert(children, tern.ui.text(tern.ui.span(e, "error")))
		end
		if s.note then
			table.insert(children, tern.ui.text(tern.ui.span(s.note, "muted")))
		end
		if #s.order == 0 and s.busy == 0 then
			table.insert(children, tern.ui.text(tern.ui.span("No pull requests yet: none for these branches, and none tracked.", "muted")))
		end
		for _, key in s.order do
			local pr = s.prs[key]
			if pr then
				table.insert(children, prCard(pr))
			end
		end
		return { main = tern.ui.col(children) }
	end,

	title = function(s: GhState): string?
		local failing = 0
		for _, pr in s.prs do
			for _, c in pr.checks do
				if c.state == "fail" then
					failing += 1
					break
				end
			end
		end
		return failing > 0 and ("Pull requests · " .. failing .. " failing") or "Pull requests"
	end,

	event = function(s: GhState, ev: UiEvent, cx: BlockCx)
		if ev.ev ~= "action" then
			return
		end
		local act, key = tostring(ev.act), ev.value
		if act == "refresh" then
			refresh(cx.pane)
			return
		end
		local pr = key and s.prs[key]
		if not pr then
			return
		end
		if act == "open" then
			cx:open(pr.data.url)
		elseif act == "send" then
			ask(cx, s.tracked.owner, failureText(pr))
			s.note = "Sent PR #" .. tostring(pr.data.number) .. "'s failures to the chat."
		elseif act == "rerun" then
			local runs: { [string]: boolean } = {}
			for _, c in pr.checks do
				if c.state == "fail" and c.run then
					runs[c.run] = true
				end
			end
			for run in runs do
				tern.process.run({ "gh", "run", "rerun", run, "--failed", "-R", pr.repo }, { timeout_ms = 20000 }, function(r: ProcessResult)
					s.note = r.status == 0 and ("Re-running run " .. run .. ".") or ("Re-run failed: " .. (string.match(r.stderr, "[^\n]+") or "?"))
					render(cx.pane)
				end)
			end
			hub[cx.pane].due = tern.now() + 5000
		end
	end,

	save = function(s: GhState): any
		return { path = s.path }
	end,
})
