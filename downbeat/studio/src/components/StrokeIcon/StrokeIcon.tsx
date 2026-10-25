import './StrokeIcon.css';

export function StrokeIcon({ d }: { d: string }) {
  return (
    <svg className="stroke-ico" viewBox="0 0 16 16" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}
