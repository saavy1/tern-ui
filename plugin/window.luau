--!strict
-- tern-ui, window half. It does two small things; everything else runs in the
-- host half, on the machine the agent and its files are on.
--
-- 1. Opens: a .ternui file becomes a `view` block and a .ternprs file a
--    `github` block, each on the file's host, whichever window asked.
-- 2. Asks: host blocks can't reach a chat, but they can open a link, and links
--    go through this window. `tern-ui:ask?pane=<chat>&text=<message>` sends the
--    message into that chat (a click on a UI nobody waits on, or "send to agent").

tern.route.open(function(req: OpenRequest, _cx: WindowCx): RouteDecision?
	if string.match(req.path, "%.ternui$") then
		return { block = "tern-ui.view", args = { req.path } }
	elseif string.match(req.path, "%.ternprs$") then
		return { block = "tern-ui.github", args = { req.path } }
	end
	return nil
end)

local function decode(s: string): string
	s = string.gsub(s, "+", " ")
	return (string.gsub(s, "%%(%x%x)", function(h: string): string
		return string.char(tonumber(h, 16) :: number)
	end))
end

tern.route.link(function(link: LinkRequest, cx: WindowCx): RouteDecision?
	if string.sub(link.url, 1, 12) ~= "tern-ui:ask?" then
		return nil
	end
	local query = string.sub(link.url, 13)
	local pane: number? = nil
	local text: string? = nil
	for k, v in string.gmatch(query, "([^&=]+)=([^&]*)") do
		local key, value = tostring(k), tostring(v)
		if key == "pane" then
			pane = tonumber(value)
		elseif key == "text" then
			text = decode(value)
		end
	end
	if pane and text and text ~= "" then
		local ok, err = pcall(function()
			cx.agents:ask(pane, text)
		end)
		if not ok then
			cx:toast("error", "tern-ui couldn't reach that chat", tostring(err))
		end
	end
	return { handled = true }
end)

-- 3. Orchestration: in a session with a tab named "orchestrator", every other
--    agent's finished turn (or a stop to wait for input) is posted into the
--    orchestrator's chat with its final message, so it never sits waiting on
--    workers that are already done. Tern queues the message while the
--    orchestrator is mid-turn.

local MAX_SUMMARY = 2000

-- The orchestrator's pane for the session holding `pane`, if that session has one.
local function orchestratorFor(cx: WindowCx, pane: number): number?
	local tab = cx.session:tab_of(pane)
	if not tab then
		return nil
	end
	local session: number? = nil
	for _, t in cx.session:tabs() do
		if t.id == tab then
			session = t.session
			break
		end
	end
	if not session then
		return nil
	end
	for _, t in cx.session:tabs() do
		if t.session == session and t.name and string.find(string.lower(t.name), "orchestrat", 1, true) then
			return t.pane
		end
	end
	return nil
end

-- Who a worker is, in a few words: its tab's name, else its title.
local function workerName(cx: WindowCx, pane: number): string
	local tab = cx.session:tab_of(pane)
	for _, t in cx.session:tabs() do
		if t.id == tab and t.name and t.name ~= "" then
			return t.name
		end
	end
	local info = cx.session:pane(pane)
	return (info and info.title and info.title ~= "") and info.title or ("pane " .. tostring(pane))
end

-- The worker's last turn (its prompt and reply) from the session daemon, which is
-- always current (the window's copy of an off-screen chat can lag a turn).
local function lastTurn(text: string): string
	local lines = string.split(text, "\n")
	-- Turns are separated by a "·" line; the last turn is everything after the last one.
	local start = 1
	for i = #lines, 1, -1 do
		if string.match(lines[i], "^%s*·%s*$") or string.find(lines[i], "Esc stops a turn", 1, true) then
			start = i + 1
			break
		end
	end
	local out = {}
	for i = start, #lines do
		local l = lines[i]
		local skip = string.match(l, "^%s*$")
			or string.match(l, "^%s*%d+:%d+%s*[AP]M%s*$")
			or string.match(l, "this turn%s*$")
			or string.match(l, "^%s*Fork from here%s*$")
		if not skip then
			table.insert(out, l)
		end
	end
	local s = table.concat(out, "\n")
	if #s > MAX_SUMMARY then
		s = "… " .. string.sub(s, #s - MAX_SUMMARY)
	end
	return s
end

local function report(cx: WindowCx, pane: number, what: string)
	local boss = orchestratorFor(cx, pane)
	if not boss or boss == pane then
		return
	end
	local head = "[worker " .. workerName(cx, pane) .. " · pane " .. tostring(pane) .. " · " .. what .. "]"
	-- The event comes a moment before the chat's final text lands: read it a little later.
	tern.timer(2500, function()
		tern.process.run({ "tern", "capture", tostring(pane), "--surfaces" }, { timeout_ms = 10000 }, function(r: ProcessResult, later: WindowCx?)
			local turn = r.status == 0 and lastTurn(r.stdout) or ""
			-- Nothing in the turn (a chat that just started): nothing to report.
			if turn == "" and what ~= "exited" and what ~= "closed" then
				return
			end
			local text = turn ~= "" and (head .. "\n" .. turn) or head
			local ok, err = pcall(function()
				(later or cx).agents:ask(boss, text)
			end)
			if not ok then
				tern.log.warn("tern-ui: couldn't tell the orchestrator", tostring(err))
			end
		end)
	end)
end

tern.on("agent_finished", function(ev: AgentFinishedEvent, cx: WindowCx)
	report(cx, ev.pane, ev.result)
end)

tern.on("agent_state", function(ev: AgentStateEvent, cx: WindowCx)
	if ev.new == "waiting_input" and ev.old ~= "waiting_input" then
		report(cx, ev.pane, "waiting for input")
	end
end)
