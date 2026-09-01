'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, UserPlus } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';

export function AddUserDialog() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setEmail('');
    setName('');
    setError(null);
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setIsSubmitting(true);
    setError(null);

    try {
      const response = await fetch('/api/admin/users', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email,
          name: name.trim() ? name.trim() : undefined,
        }),
      });
      const payload = (await response.json().catch(() => ({}))) as {
        error?: string;
        data?: { emailSent?: boolean; resent?: boolean; setupUrl?: string | null };
      };

      if (!response.ok) {
        setError(payload.error || 'Failed to add user');
        return;
      }

      const setupUrl = payload.data?.setupUrl;
      if (payload.data?.emailSent) {
        toast.success(
          payload.data.resent ? `Invite resent to ${email}` : `Invite sent to ${email}`
        );
      } else if (setupUrl) {
        await navigator.clipboard.writeText(setupUrl).catch(() => undefined);
        toast.success('User created. Invite email was not sent; the setup link was copied.');
      } else {
        toast.success('User created');
      }

      reset();
      setOpen(false);
      router.refresh();
    } catch {
      setError('Failed to add user');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) reset();
      }}
    >
      <DialogTrigger asChild>
        <Button size="sm">
          <UserPlus className="h-4 w-4" />
          Add user
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>Add user</DialogTitle>
            <DialogDescription>
              Create an account and send a link so they can set their password. They do not need the
              invite code.
            </DialogDescription>
          </DialogHeader>
          <div className="mt-4 space-y-3">
            {error ? (
              <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {error}
              </p>
            ) : null}
            <div className="space-y-1.5">
              <Label htmlFor="invite-email">Email</Label>
              <Input
                id="invite-email"
                type="email"
                required
                autoComplete="off"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="person@studio.com"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="invite-name">Name (optional)</Label>
              <Input
                id="invite-name"
                type="text"
                autoComplete="off"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Ada Lovelace"
              />
            </div>
          </div>
          <DialogFooter className="mt-5">
            <Button type="submit" disabled={isSubmitting || !email.trim()}>
              {isSubmitting ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              Send invite
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
