// The microphone, camera and speaker saved in the preferences are device ids, and ids change: a headset is
// unplugged or switched off, a remote desktop session offers its own devices, a browser resets them. A saved
// device that is not there now must give way to the default one rather than fail ("No device found") or play
// nowhere, without forgetting the choice: the headset may be back for the next call.

/**
 * Whether the browser lists this device now: true or false, or null when it cannot tell. It cannot tell when
 * it shows no device of that kind, or hides their ids: before any capture permission, browsers list devices
 * with empty ids, and some list no speaker at all.
 */
export function isListed(list: readonly Pick<MediaDeviceInfo, "kind" | "deviceId">[], kind: MediaDeviceKind, id: string): boolean | null {
  const ofKind = list.filter((d) => d.kind === kind);
  if (!ofKind.length || ofKind.some((d) => !d.deviceId)) return null;
  return ofKind.some((d) => d.deviceId === id);
}

/** The capture errors a device that is not there gives. */
export const isMissingDevice = (e: unknown) => {
  const name = (e as { name?: string })?.name ?? "";
  return name === "NotFoundError" || name === "OverconstrainedError";
};
