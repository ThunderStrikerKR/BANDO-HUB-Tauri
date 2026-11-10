/** Consistent mouse/keyboard-accessible search control for management screens.
 *  Owns presentation only; filtering remains in the calling screen.
 */
export function ManagementSearch({
  label, placeholder, value, onChange,
}: {
  label: string;
  placeholder: string;
  value: string;
  onChange: (next: string) => void;
}) {
  return (
    <div className="management-search-field">
      <span aria-hidden="true" className="management-search-icon">⌕</span>
      <input type="text" aria-label={label} placeholder={placeholder}
        value={value} onChange={(event) => onChange(event.target.value)} />
    </div>
  );
}
