// src/lib/timing.js
// Medidor de tempo para diagnóstico de latência no fluxo do bot.

/**
 * Cria um timer que registra checkpoints e gera log de resumo.
 * @param {object} context - { instanceId, phone, step? } para o log
 * @returns {{ mark: (label: string) => void, elapsed: () => number, log: (logger: object) => void }}
 */
function startTimer(context = {}) {
  const start = Date.now();
  const marks = [];

  return {
    mark(label) {
      marks.push({ label, ms: Date.now() - start });
    },

    elapsed() {
      return Date.now() - start;
    },

    log(logger) {
      const total = Date.now() - start;
      const breakdown = marks.map((m, i) => {
        const delta = i === 0 ? m.ms : m.ms - marks[i - 1].ms;
        return `${m.label}=${delta}ms`;
      });
      logger.info(
        {
          ...context,
          totalMs: total,
          breakdown: breakdown.join(" | "),
          marks: marks.map((m) => ({ label: m.label, ms: m.ms })),
        },
        `[Timer] ${total}ms total | ${breakdown.join(" | ")}`,
      );
    },
  };
}

module.exports = { startTimer };
