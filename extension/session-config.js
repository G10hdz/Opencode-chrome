// Tope de sesiones que la persona pone en las opciones. Sin valor, una sesión.
// Misma lógica en src/sessions.js: el paquete npm no incluye la extensión.

export const DEFAULT_PORT = 19223;
export const SESSION_MAX = 10;

export function clampSessions(value) {
  const n =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim() !== ""
        ? Number(value)
        : NaN;
  if (!Number.isInteger(n) || n < 1) return 1;
  return Math.min(SESSION_MAX, n);
}

export function clampPort(value) {
  const n =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^\d+$/.test(value.trim())
        ? Number(value)
        : NaN;
  if (!Number.isInteger(n) || n < 1 || n > 65535) return null;
  return n;
}

export function parseSessionConfig(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { sessions: 1, port: DEFAULT_PORT };
  }
  return {
    sessions: clampSessions(raw.sessions),
    port: clampPort(raw.port) ?? DEFAULT_PORT,
  };
}

export function sessionPorts(base, sessions) {
  const start = clampPort(base) ?? DEFAULT_PORT;
  const count = clampSessions(sessions);
  const ports = [];
  for (let i = 0; i < count && start + i <= 65535; i++) ports.push(start + i);
  return ports.length ? ports : [start];
}
