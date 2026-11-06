import { useEffect, useRef, useState } from 'react'
import { Check, Copy } from 'lucide-react'
import { Button } from '../ui'

// A terminal command next to its copy button; the text stays readable when the clipboard is blocked.
export default function CopyCommand({ command, disabled = false }) {
  const [copied, setCopied] = useState(false)
  const timer = useRef(null)
  useEffect(() => () => clearTimeout(timer.current), [])
  const copy = async () => {
    try { await navigator.clipboard.writeText(command); setCopied(true); timer.current = setTimeout(() => setCopied(false), 1500) }
    catch { /* clipboard blocked: the command stays readable */ }
  }
  return <div className="flex flex-wrap items-center gap-2" data-copy-command>
    <code className="rounded bg-x-surface px-1.5 py-0.5 font-mono text-x-ink">{command}</code>
    <Button size="sm" icon={copied ? Check : Copy} disabled={disabled} onClick={copy}>{copied ? 'Copied' : 'Copy command'}</Button>
  </div>
}
