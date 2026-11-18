export function setupPrompt(deviceId, task = '') {
  return `Set up my iPhone for control through IVE's built-in device tools. I authorized setup and connecting the chosen iPhone to this session in Devices. ${deviceId ? `The selected device id is ${deviceId}.` : 'If exactly one physical iPhone is connected, use that one. Otherwise ask me to choose it in Devices.'}
Start with device_setup(action="check"). Use prepare to build the bundled Mac helper, pair to initiate Apple pairing, developer_mode if required, and verify to check a fresh screenshot. Each action starts a background job: poll check until it finishes before the next step. If Xcode is missing, open_xcode opens its official App Store page; guide me through Apple's installation/sign-in and continue when ready.
Do everything allowed by this session's permissions. Never widen those permissions yourself. Ask me only for steps that require me physically: plugging in, unlocking, Trust This Computer, Apple ID/admin approval, or Developer Mode confirmation/restart. Do not reset privacy settings, disable protections, download arbitrary helpers or edit unrelated files. On a failed/uncertain action check the current state before trying anything else.
After verify succeeds the iPhone is assigned to you. Call device_list and device_observe and tell me when you can see its screen. A screenshot proves observation, not successful tapping. Never create a note or send a message merely to test setup. I can stop setup or control in Devices.
${task.trim() ? `Only after setup and a fresh observation succeed, perform this task within its stated scope:\n${task.trim()}` : 'Wait for my task before changing anything on the phone.'}`
}

export function deviceTaskPrompt(deviceId, task = '') {
  return `IVE Devices assigned iPhone ${deviceId} to this session. Use device_list and device_observe to see it. Read the screenshot before acting; use device_act with a fresh frame_id and unique command_id, then observe to verify. Never blindly repeat uncertain input. Stay within my task. ${task.trim() || 'Wait for my task before changing anything on the iPhone.'}`
}

export async function startDeviceAgent({ api, provider, fullAccess, deviceId, setup = true, task = '', onSession }) {
  const session = await api.quickSession({ cli_type: provider, name: setup ? 'Set up my iPhone' : 'Use my iPhone',
    permission_mode: fullAccess ? 'bypassPermissions' : 'default', auto_start: true })
  if (!session?.id) throw new Error('The agent session could not be created.')
  onSession?.(session)
  try {
    if (session.autostart?.ok === false) throw new Error('The agent could not start. Open its session to finish sign-in or setup.')
    if (setup) {
      await api.deviceHubAction('grant-setup', { session_id: session.id, device_id: deviceId || null, control_after_setup: true })
    } else {
      await api.deviceHubAction('assign', { session_id: session.id, device_id: deviceId })
    }
    const message = setup ? setupPrompt(deviceId, task) : deviceTaskPrompt(deviceId, task)
    await api.sendSessionInput(session.id, message, { ready_timeout: 25 })
    return session
  } catch (error) {
    error.deviceSessionId = session.id
    throw error
  }
}
