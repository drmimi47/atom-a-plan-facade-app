import styles from './TopRightBar.module.css';

interface TopRightBarProps {
  /** Run the demo. Placeholder for now. */
  onDemo: () => void;
  /** Signed-in user's email — shown as the sign-out hover tooltip. */
  email?: string | null;
  /** Sign out (signed-in) or end the guest session. */
  onSignOut: () => void;
}

/**
 * Top-right action cluster, mirroring the top-left toolbar's styling: a "Demo" text
 * pill followed by a circular sign-out icon button. Rendered once past the login gate.
 */
export function TopRightBar({ onDemo, email, onSignOut }: TopRightBarProps) {
  return (
    <div className={styles.bar}>
      <button type="button" className={styles.demo} onClick={onDemo}>
        Demo
      </button>
      <button
        type="button"
        className={styles.signOut}
        onClick={onSignOut}
        aria-label="Sign out"
        title={email ? `Sign out (${email})` : 'Sign out'}
      >
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
          <polyline points="16 17 21 12 16 7" />
          <line x1="21" y1="12" x2="9" y2="12" />
        </svg>
      </button>
    </div>
  );
}
