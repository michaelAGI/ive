// An eye that really closes: the dark upper lid slides down over the iris when
// the lid-closed mode is on and lifts when it is off. It draws in the text
// colour, so it reads black on the light theme and white on the dark one.
// While the mode runs the eye blinks every few seconds; reduced motion keeps
// it still. Pure SVG + CSS, no library.
export default function EyelidIcon({ closed = false, size = 20, blink = false, className = '' }) {
  return (
    <svg
      className={`ive-eyelid${closed ? ' is-closed' : ''}${blink ? ' is-blinking' : ''} ${className}`}
      width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false"
    >
      <defs>
        <clipPath id="ive-eyelid-clip">
          <path d="M2 12 Q12 1.5 22 12 Q12 22.5 2 12 Z" />
        </clipPath>
      </defs>
      {/* eye white and iris, only visible inside the almond */}
      <g clipPath="url(#ive-eyelid-clip)">
        <circle className="ive-eyelid-iris" cx="12" cy="12" r="4.2" fill="currentColor" />
        <circle className="ive-eyelid-glint" cx="13.6" cy="10.4" r="1.1" fill="var(--x-bg, #fff)" />
        {/* the upper lid: a dark shape that slides down */}
        <path className="ive-eyelid-lid" d="M-2 -12 H26 V12 Q12 22.5 -2 12 Z" fill="currentColor" />
      </g>
      {/* outline: open almond, or the closed curve with lashes */}
      <path className="ive-eyelid-outline" d="M2 12 Q12 1.5 22 12 Q12 22.5 2 12 Z" stroke="currentColor" strokeWidth="1.9" strokeLinejoin="round" />
      <g className="ive-eyelid-closed" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round">
        <path d="M2 10 Q12 21 22 10" />
        <path d="M6.2 15.2 L4.6 18.4" />
        <path d="M12 17.1 L12 20.6" />
        <path d="M17.8 15.2 L19.4 18.4" />
      </g>
    </svg>
  )
}
