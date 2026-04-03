/**
 * Один MediaStream микрофона на всё SPA: подготовка + репетиция без повторных getUserMedia.
 */

let sharedStream = null;

export async function acquireSharedMic() {
  if (sharedStream?.getAudioTracks().some((t) => t.readyState === "live")) {
    return sharedStream;
  }
  sharedStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  return sharedStream;
}

export function releaseSharedMic() {
  if (!sharedStream) return;
  sharedStream.getTracks().forEach((t) => t.stop());
  sharedStream = null;
}

export function hasLiveSharedMic() {
  return Boolean(sharedStream?.getAudioTracks().some((t) => t.readyState === "live"));
}
