// Project name rules — pure, no node builtins.
//
// This half is imported by the modal (a client component), so it must stay
// free of `fs`/`os`/`path`: the client only needs "is this a legal folder
// name", while the server needs "and can I create it". `project-paths.ts`
// holds the filesystem half and re-exports nothing from here that it does not
// need, so a client import cannot drag `fs/promises` into the browser bundle.

export const MAX_PROJECT_NAME = 60;

const RESERVED = new Set([
  "con", "prn", "aux", "nul",
  "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8", "com9",
  "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
]);

/** Everything Windows refuses in a folder name, plus both path separators. */
const ILLEGAL = /[<>:"/\\|?*\u0000-\u001f]/;

export type NameProblem =
  | "empty"
  | "too-long"
  | "illegal-characters"
  | "trailing-dot"
  | "reserved"
  | "dot-directory";

/** Why a project name is unacceptable, or null when it is fine. */
export function projectNameProblem(raw: string): NameProblem | null {
  const name = (raw ?? "").trim();
  if (!name) return "empty";
  if (name.length > MAX_PROJECT_NAME) return "too-long";
  if (ILLEGAL.test(name)) return "illegal-characters";
  if (/[. ]$/.test(name)) return "trailing-dot";
  if (name === "." || name === "..") return "dot-directory";
  if (RESERVED.has(name.split(".")[0].toLowerCase())) return "reserved";
  return null;
}

export function projectNameMessage(problem: NameProblem): string {
  switch (problem) {
    case "empty":
      return "Enter a project name";
    case "too-long":
      return `Keep the name under ${MAX_PROJECT_NAME} characters`;
    case "illegal-characters":
      return 'Names cannot contain \\ / : * ? " < > |';
    case "trailing-dot":
      return "Names cannot end with a dot or a space";
    case "reserved":
      return "That name is reserved by the system";
    case "dot-directory":
      return 'Choose a real name, not "." or ".."';
  }
}
