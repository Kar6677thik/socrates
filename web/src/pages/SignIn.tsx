import { useState, type FormEvent } from 'react';
import { api, qc, type Session } from '../lib/api';
import { Button, Card, Field } from '../components/ui';

/** Owner sign-in for a deployed Socrates: password + authenticator code. */
export default function SignIn() {
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.post('/session', { password, code: code.replace(/\s/g, '') });
      qc.setQueryData<Session>(['/session'], { signedIn: true, loginRequired: true });
      qc.invalidateQueries();
    } catch (err: any) {
      setError(err.message);
      setCode('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-full grid place-items-center px-4 py-16">
      <div className="w-full max-w-[340px] fade-in">
        <div className="flex items-center gap-2 mb-6">
          <span className="w-7 h-7 rounded-md bg-elev border border-line-strong grid place-items-center font-serif text-[14px]">S</span>
          <span className="font-semibold tracking-[-0.01em] text-[15px]">Socrates</span>
        </div>
        <Card className="p-5">
          <form onSubmit={submit} className="space-y-4">
            <Field label="Password">
              <input className="field h-9 w-full" type="password" autoComplete="current-password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} />
            </Field>
            <Field label="Authenticator code">
              <input
                className="field h-9 w-full font-mono tracking-[0.2em]"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={7}
                placeholder="000000"
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/[^\d ]/g, ''))}
              />
            </Field>
            {error && <p className="text-bad text-[13px]">{error}</p>}
            <Button type="submit" variant="primary" size="lg" className="w-full"disabled={busy || !password || code.replace(/\s/g, '').length !== 6}>
              {busy ? 'Signing in…' : 'Sign in'}
            </Button>
          </form>
        </Card>
        <p className="text-faint text-[12px] mt-4">Sessions end after 30 minutes idle or 12 hours.</p>
      </div>
    </div>
  );
}
