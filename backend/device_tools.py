"""Shared MCP contract: same tools for Claude/Codex workers and Commander."""
import json


def build_tools(api_call):
    def call(operation, args, method="POST"):
        value = api_call(method, "/device-hub/" + operation, args if method == "POST" else None)
        if not isinstance(value, dict):
            value = {"error": "Invalid device response"}
        image = value.pop("image_base64", None)
        content = [{"type": "text", "text": json.dumps(value)}]
        if image:
            content.append({"type": "image", "data": image, "mimeType": "image/png"})
        return {"_mcp_content": content, "_mcp_error": bool(value.get("error"))}

    def spec(description, properties, required, handler):
        return {"description": description, "inputSchema": {"type": "object", "properties": properties,
            "required": required, "additionalProperties": False}, "handler": handler}

    identifier = {"type": "string", "description": "Exact device id from device_list; never guess."}
    return {
        "device_list": spec("List iPhones the user assigned to you, setup progress, and the bundled read-only photo duplicate report script. Use that script only on a folder of exported copies explicitly chosen by the user, with the session's normal execution permissions. An open or paired iPhone does not grant control or filesystem access to its photo library.",
            {}, [], lambda args: call("status", {}, "GET")),
        "device_setup": spec("Run the setup the user requested in Devices. Start with check, prepare the bundled helper, pair the chosen iPhone, request developer_mode if needed, then verify a fresh screenshot. Mutating steps start a job; poll check until it finishes. Ask the user only for Apple ID/admin prompts, Trust, unlocking or Developer Mode confirmation that Apple requires. Never disable security, install third-party downloads or blindly retry an uncertain step. Ready verifies screen access, not an input effect.",
            {"action": {"type": "string", "enum": ["check", "prepare", "pair", "developer_mode", "verify", "open_xcode"]},
             "device_id": identifier}, ["action"], lambda args: call("setup", args)),
        "device_observe": spec("Get a fresh screenshot and frame_id of your assigned iPhone. Read the image before choosing coordinates. Images expire after 45 seconds and each input consumes the frame. Stop if the visible device state is unexpected.",
            {"device_id": identifier}, ["device_id"], lambda args: call("observe", args)),
        "device_act": spec("Send ONE input to the assigned iPhone. Use a fresh frame_id and a unique command_id. Coordinates are normalized 0..1; tap/swipe require portrait. arguments: tap={x,y}, swipe={x1,y1,x2,y2,duration?}, type_text={text}, home={}, key={key: enter|backspace|escape|tab}. Text replaces the iPhone clipboard. A submitted action is NOT proof of success: observe afterward. On outcome_unknown inspect before any new command. Retries of a recorded command_id return its saved result (last 256 commands); never intentionally reuse IDs. Only perform actions within the user's task; device access does not authorize unrelated messages, purchases or deletion.",
            {"device_id": identifier, "frame_id": {"type": "string"}, "command_id": {"type": "string"},
             "action": {"type": "string", "enum": ["tap", "swipe", "type_text", "home", "key"]},
             "arguments": {"type": "object"}}, ["device_id", "frame_id", "command_id", "action", "arguments"],
            lambda args: call("act", args)),
        "device_release": spec("Stop control of your assigned iPhone and discard its screenshots and permission.",
            {"device_id": identifier}, ["device_id"], lambda args: call("release", args)),
    }
