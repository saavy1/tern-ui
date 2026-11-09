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
