"""Authenticated REST seam for the Devices UI and session-bound MCP tools."""
from aiohttp import web
import session_proofs
from device_adapter import DeviceError
from device_hub import DeviceHub

HUB = web.AppKey("device_hub", DeviceHub)


def register(app, *, data_dir, get_session, local_owner):
    hub = app[HUB] = DeviceHub(data_dir)

    async def session(identifier):
        if not isinstance(identifier, str) or not identifier or len(identifier) > 100:
            raise DeviceError("invalid_session", "Choose an agent session.", 400)
        row = await get_session(identifier)
        if not row or row.get("archived") or row.get("cli_type") == "shell":
            raise DeviceError("invalid_session", "Choose an active Claude Code or Codex session.", 400)
        return row

    def owner(request):
        if (not request.get("auth") or request.headers.get("X-IVE-Session-Id")
                or request.headers.get("X-IVE-Session-Type") or not local_owner(request, request["auth"])):
            raise DeviceError("local_owner_required", "Open Devices on this Mac to change access.", 403)

    async def caller(request):
        sid = request.headers.get("X-IVE-Session-Id", "")
        if not sid:
            owner(request)
            return None
        if session_proofs.check(sid, request.headers.get(session_proofs.MCP_HEADER)) != session_proofs.OK:
            raise DeviceError("session_proof_required", "Restart this agent session to connect its device tools securely.", 403)
        return await session(sid)

    async def handle(request):
        try:
            operation = request.match_info["operation"]
            body = await request.json() if request.method == "POST" else {}
            if not isinstance(body, dict):
                raise DeviceError("invalid_request", "Expected an object.", 400)
            if operation in {"assign", "unassign", "grant-setup", "stop-setup"}:
                owner(request)
                if operation == "assign":
                    row = await session(body.get("session_id"))
                    if row.get("permission_mode") in {"plan", "read-only"}:
                        raise DeviceError("plan_mode", "Leave plan mode before assigning iPhone control.")
                    result = await hub.assign(body.get("device_id"), row["id"])
                elif operation == "unassign":
                    hub.revoke(body.get("device_id"))
                    result = {"stopped": True}
                elif operation == "grant-setup":
                    row = await session(body.get("session_id"))
                    if row.get("permission_mode") in {"plan", "read-only"}:
                        raise DeviceError("plan_mode", "Setup needs a session that can run tools.")
                    result = hub.setup_grant(row["id"], body.get("device_id"), body.get("control_after_setup", False))
                else:
                    hub.stop_setup()
                    result = {"stopped": True}
            else:
                row = await caller(request)
                sid = row["id"] if row else None
                if operation == "status":
                    if sid and not (hub.setup and hub.setup["session_id"] == sid) and not any(
                            g["session_id"] == sid for g in hub.assignments.values()):
                        raise DeviceError("assignment_required", "Ask the user to assign an iPhone or start setup in Devices.", 403)
                    result = await hub.status(sid)
                elif operation == "setup":
                    if not sid:
                        raise DeviceError("agent_required", "Start the setup agent in Devices first.", 400)
                    if row.get("permission_mode") in {"plan", "read-only"} and body.get("action") != "check":
                        raise DeviceError("plan_mode", "Setup actions are unavailable in plan mode.", 403)
                    result = await hub.setup_action(sid, body.get("action", "check"), body.get("device_id"))
                elif operation == "observe":
                    result = await hub.observe(body.get("device_id"), sid)
                elif operation == "act":
                    if not sid or row.get("permission_mode") in {"plan", "read-only"}:
                        raise DeviceError("control_denied", "A controlling agent session is required.", 403)
                    result = await hub.act(body.get("device_id"), sid, body)
                elif operation == "release":
                    hub.lease(body.get("device_id"), sid)
                    hub.revoke(body.get("device_id"))
                    result = {"stopped": True}
                else:
                    raise DeviceError("not_found", "Unknown device operation.", 404)
            return web.json_response(result, headers={"Cache-Control": "no-store"})
        except DeviceError as exc:
            return web.json_response({"error": str(exc), "code": exc.code}, status=exc.status,
                                     headers={"Cache-Control": "no-store"})
        except (ValueError, TypeError):
            return web.json_response({"error": "Invalid device request.", "code": "invalid_request"}, status=400)

    app.router.add_get("/api/device-hub/{operation:status}", handle)
    app.router.add_post("/api/device-hub/{operation:assign|unassign|grant-setup|stop-setup|setup|observe|act|release}", handle)
    async def close(_):
        await hub.close()
    app.on_shutdown.append(close)
