import { useEffect } from 'react';
import styles from './ApiKeyNotice.module.css';

/** Which AI feature the user just reached for. */
export type ApiKeyFeature = 'anthropic' | 'gemini';

interface ApiKeyNoticeProps {
  /** The feature whose key is missing — picks the copy below. */
  feature: ApiKeyFeature;
  /** Dismiss (backdrop click, Escape, OK, or ×). */
  onClose: () => void;
}

/**
 * Copy per feature. `degraded` explains what still happens: the constraint/prompt
 * parsers keep working on a local regex fallback, but the facade renderer has no
 * offline equivalent and is simply unavailable.
 */
const COPY: Record<ApiKeyFeature, { title: string; body: string; degraded: string }> = {
  anthropic: {
    title: 'AI parsing is disabled',
    body: 'This feature used the Anthropic API, and its key has been removed from this project.',
    degraded:
      'Your input was still applied using the built-in parser. It handles plain phrasing like “min wall thickness 6in” or “5 15x15 rooms”, but not free-form sentences.',
  },
  gemini: {
    title: 'The AI renderer is disabled',
    body: 'The facade renderer used the Google Gemini API, and its key has been removed from this project.',
    degraded:
      'Nothing was rendered. Every other part of the app — drawing, partitions, constraints and facade rules — is unaffected.',
  },
};

/**
 * Modal shown when a user action reaches an AI feature whose API key has been
 * decommissioned. Unlike LoginModal this is *not* a gate: it reports something that
 * already happened, so backdrop click and Escape both dismiss it.
 */
export function ApiKeyNotice({ feature, onClose }: ApiKeyNoticeProps) {
  const { title, body, degraded } = COPY[feature];

  // Escape closes. Bound on the document so it works regardless of focus.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <>
      <div className={styles.backdrop} onClick={onClose} />
      <div className={styles.card} role="alertdialog" aria-modal="true" aria-label={title}>
        <button type="button" className={styles.close} onClick={onClose} aria-label="Dismiss">
          ×
        </button>

        <div className={styles.header}>
          <span className={styles.badge} aria-hidden="true">
            !
          </span>
          <span className={styles.title}>{title}</span>
        </div>

        <p className={styles.body}>{body}</p>
        <p className={styles.note}>{degraded}</p>

        <button type="button" className={styles.primary} onClick={onClose} autoFocus>
          OK
        </button>
      </div>
    </>
  );
}
