--!strict
-- tern-ui, window half: a .ternui file opens as a tern-ui view block on the file's
-- host (the machine the agent that wrote it runs on), whichever window asked.

tern.route.open(function(req: OpenRequest, _cx: WindowCx): RouteDecision?
	if string.match(req.path, "%.ternui$") then
		return { block = "tern-ui.view", args = { req.path } }
	end
	return nil
end)
