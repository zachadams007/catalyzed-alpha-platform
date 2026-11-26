export function Loader({ text = "Generating signals…" }: { text?: string }) {
  return (
    <div className="empty" style={{ border: "none" }} role="status" aria-live="polite" aria-busy="true">
      <span className="spinner" style={{ width: 26, height: 26 }} aria-hidden="true" />
      <p>{text}</p>
    </div>
  );
}
