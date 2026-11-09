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

type Spec = { v: number?, title: string?, view: any?, waiting: boolean? }
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
		elseif ev.ev ~= "change" and s.spec and s.spec.waiting then
			s.answered = tostring(ev.act or ev.item or ev.ev)
		end
	end,

	save = function(s: State): any
		return { path = s.path }
	end,
})
