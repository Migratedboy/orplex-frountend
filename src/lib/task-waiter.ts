import { getCurrentTask } from "./background-chat";

export function waitForAnswer(timeoutMs = 300_000): Promise<string> {
  const waitingId = getCurrentTask()?.id;
  return new Promise((resolve) => {
    let resolved = false;
    const done = (value: string) => {
      if (resolved) return;
      resolved = true;
      clearInterval(check);
      clearTimeout(timer);
      resolve(value);
    };
    const check = setInterval(() => {
      const bg = getCurrentTask();
      if (!bg || bg.id !== waitingId || bg.status === "done" || bg.status === "error") {
        done("(task cancelled)");
        return;
      }
      if (bg.question?.answered) {
        done(bg.question.answer || "");
      }
    }, 500);
    const timer = setTimeout(() => {
      done("(timed out)");
    }, timeoutMs);
  });
}
