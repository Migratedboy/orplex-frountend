// bg-keeper.ts - Prevents browser tab suspension/throttling during active LLM streaming
// by playing an inaudible, low-frequency sound which tells the browser the page is actively playing media.

let audioContext: AudioContext | null = null;
let oscillator: OscillatorNode | null = null;

export function startBackgroundKeeper() {
  if (typeof window === "undefined") return;
  try {
    const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
    if (!AudioContextClass) return;

    if (!audioContext) {
      audioContext = new AudioContextClass();
    }

    if (audioContext.state === "suspended") {
      audioContext.resume();
    }

    if (!oscillator) {
      const gainNode = audioContext.createGain();
      // 0.0001 is low enough to be completely inaudible but non-zero so browser keeps it running
      gainNode.gain.value = 0.0001; 
      gainNode.connect(audioContext.destination);

      oscillator = audioContext.createOscillator();
      // Low frequency (20 Hz) is below human hearing range
      oscillator.frequency.value = 20; 
      oscillator.connect(gainNode);
      oscillator.start();
    }
  } catch (err) {
    console.warn("[bg-keeper] Failed to start background keeper:", err);
  }
}

export function stopBackgroundKeeper() {
  try {
    if (oscillator) {
      oscillator.stop();
      oscillator.disconnect();
      oscillator = null;
    }
    if (audioContext && audioContext.state !== "closed") {
      audioContext.close();
      audioContext = null;
    }
  } catch (err) {
    console.warn("[bg-keeper] Failed to stop background keeper:", err);
  }
}
