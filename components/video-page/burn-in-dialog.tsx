'use client';

import { useCallback, useState, type ReactNode } from 'react';
import { Flame, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { BurnInPreview } from '@/components/video-page/burn-in-preview';
import type { SubtitleTrackOption } from '@/components/video-page/types';
import {
  BURN_IN_BOUNDS,
  BURN_IN_FONTS,
  burnInStyleSchema,
  burnInVersionLabel,
  type BurnInFontId,
  type BurnInPosition,
  type BurnInStyle,
} from '@/lib/rough-cut/subtitle-style';

/**
 * The knobs behind a burned-in caption, with a picture of what they do.
 *
 * The sliders take their ends from `BURN_IN_BOUNDS` and the form opens on
 * `burnInStyleSchema`'s own defaults, so no control can offer a value the route
 * would refuse. The two enumerated controls are narrower than the schema on
 * purpose: `PLAYBACK_RATES` is a curated subset of the 0.5-2 the API accepts,
 * because the speeds either side of 1 are the only ones anyone wants and 2x is
 * unwatchable.
 */

interface BurnInDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Resolves to an error message to show inline, or null when the job was queued. */
  onStart: (style: Partial<BurnInStyle>, subtitleId?: string) => Promise<string | null>;
  starting: boolean;
  /** The version's caption tracks, offered as an alternative to its transcript. */
  subtitles: SubtitleTrackOption[];
}

const DEFAULT_STYLE: BurnInStyle = burnInStyleSchema.parse({});

/** The transcript, which is what the API picks when no `subtitleId` is sent. */
const TRANSCRIPT_SOURCE = '__transcript__';

const POSITION_LABELS: Record<BurnInPosition, string> = {
  bottom: 'Bottom',
  center: 'Centre',
  top: 'Top',
};

const PLAYBACK_RATES = [0.9, 1, 1.1, 1.25, 1.5];

export function BurnInDialog({
  open,
  onOpenChange,
  onStart,
  starting,
  subtitles,
}: BurnInDialogProps) {
  const [style, setStyle] = useState<BurnInStyle>(DEFAULT_STYLE);
  const [source, setSource] = useState<string>(TRANSCRIPT_SOURCE);
  const [error, setError] = useState<string | null>(null);

  // A track deleted since the dialog last opened must not stay selected: the
  // POST would answer 404 for a source nobody can see any more. Derived rather
  // than corrected in an effect, so no render ever shows the stale choice.
  const chosenSource =
    source === TRANSCRIPT_SOURCE || subtitles.some((track) => track.id === source)
      ? source
      : TRANSCRIPT_SOURCE;

  const set = useCallback(<K extends keyof BurnInStyle>(key: K, value: BurnInStyle[K]) => {
    setStyle((current) => ({ ...current, [key]: value }));
  }, []);

  const close = useCallback(() => {
    setError(null);
    onOpenChange(false);
  }, [onOpenChange]);

  // A refusal that arrives after the dialog was dismissed is kept rather than
  // dropped: the page deliberately does not toast start refusals, so reopening
  // is the only place left to read it, and one start runs at a time.

  const handleStart = useCallback(async () => {
    setError(null);
    const message = await onStart(
      style,
      chosenSource === TRANSCRIPT_SOURCE ? undefined : chosenSource
    );
    if (message) setError(message);
  }, [chosenSource, onStart, style]);

  return (
    <Dialog
      open={open}
      // Closing while the POST is in flight is allowed on purpose: the request
      // has no timeout, and a modal that cannot be dismissed until an answer
      // arrives is a trap. The hook outlives the dialog and the page reports
      // whatever comes back.
      onOpenChange={(next) => {
        if (!next) close();
      }}
    >
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Burn subtitles into a new version</DialogTitle>
          <DialogDescription>
            The captions are rendered into the picture and the result is added as a new version of
            this video, labelled {burnInVersionLabel(style.playbackRate)}. The version you are
            watching now is left exactly as it is.
          </DialogDescription>
        </DialogHeader>

        <BurnInPreview style={style} />

        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            id="burn-in-source"
            label="Caption source"
            hint="Transcript uses this version's own words; a track burns that file instead."
          >
            {(describedBy) => (
              <Select value={chosenSource} onValueChange={setSource}>
                <SelectTrigger id="burn-in-source" aria-describedby={describedBy}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={TRANSCRIPT_SOURCE}>Transcript</SelectItem>
                  {subtitles.map((track) => (
                    <SelectItem key={track.id} value={track.id}>
                      {track.label} ({track.language})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </Field>

          <Field
            id="burn-in-font"
            label="Font"
            hint="Rendered with the font installed on the worker, not on this machine."
          >
            {(describedBy) => (
              <Select
                value={style.font}
                onValueChange={(value) => set('font', value as BurnInFontId)}
              >
                <SelectTrigger id="burn-in-font" aria-describedby={describedBy}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {BURN_IN_FONTS.map((entry) => (
                    <SelectItem key={entry.id} value={entry.id}>
                      {entry.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </Field>

          <RangeField
            id="burn-in-font-size"
            label="Font size"
            value={style.fontSize}
            step={1}
            {...BURN_IN_BOUNDS.fontSize}
            display={`${style.fontSize} pt`}
            hint="Measured on a 1080-line frame and scaled to the real height."
            onChange={(value) => set('fontSize', Math.round(value))}
          />

          <div className="grid grid-cols-2 gap-3">
            <ColorField
              id="burn-in-text-colour"
              label="Text colour"
              value={style.textColor}
              onChange={(value) => set('textColor', value)}
            />
            <ColorField
              id="burn-in-outline-colour"
              label="Outline colour"
              value={style.outlineColor}
              onChange={(value) => set('outlineColor', value)}
            />
          </div>

          <RangeField
            id="burn-in-outline-width"
            label="Outline width"
            value={style.outlineWidth}
            step={0.5}
            {...BURN_IN_BOUNDS.outlineWidth}
            display={`${style.outlineWidth}`}
            onChange={(value) => set('outlineWidth', value)}
          />

          <RangeField
            id="burn-in-background-opacity"
            label="Box behind text"
            value={style.backgroundOpacity}
            step={0.1}
            {...BURN_IN_BOUNDS.backgroundOpacity}
            display={
              style.backgroundOpacity === 0
                ? 'Off'
                : `${Math.round(style.backgroundOpacity * 100)}%`
            }
            hint="Zero leaves the outline alone; above it a box is drawn in the outline colour."
            onChange={(value) => set('backgroundOpacity', value)}
          />

          <Field id="burn-in-position" label="Position">
            {(describedBy) => (
              <Select
                value={style.position}
                onValueChange={(value) => set('position', value as BurnInPosition)}
              >
                <SelectTrigger id="burn-in-position" aria-describedby={describedBy}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(Object.keys(POSITION_LABELS) as BurnInPosition[]).map((value) => (
                    <SelectItem key={value} value={value}>
                      {POSITION_LABELS[value]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </Field>

          <RangeField
            id="burn-in-margin"
            label="Vertical margin"
            value={style.marginVertical}
            step={1}
            {...BURN_IN_BOUNDS.marginVertical}
            display={`${style.marginVertical} px`}
            onChange={(value) => set('marginVertical', Math.round(value))}
          />

          <RangeField
            id="burn-in-words"
            label="Caption speed: fewer words = faster changes"
            value={style.maxWordsPerCue}
            step={1}
            {...BURN_IN_BOUNDS.maxWordsPerCue}
            display={`${style.maxWordsPerCue} words`}
            onChange={(value) => set('maxWordsPerCue', Math.round(value))}
          />

          <RangeField
            id="burn-in-cue-seconds"
            label="Longest caption"
            hint="A caption changes when it hits this many seconds or the word limit, whichever comes first."
            value={style.maxCueSeconds}
            step={0.5}
            {...BURN_IN_BOUNDS.maxCueSeconds}
            display={`${style.maxCueSeconds}s`}
            onChange={(value) => set('maxCueSeconds', value)}
          />

          <Field
            id="burn-in-rate"
            label="Playback speed"
            hint="Re-times the picture and the audio too, not just the captions. The preview does not show it."
          >
            {(describedBy) => (
              <Select
                value={String(style.playbackRate)}
                onValueChange={(value) => set('playbackRate', Number(value))}
              >
                <SelectTrigger id="burn-in-rate" aria-describedby={describedBy}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PLAYBACK_RATES.map((rate) => (
                    <SelectItem key={rate} value={String(rate)}>
                      {rate}&times;
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </Field>

          <div className="flex items-end gap-4 text-xs">
            <label className="flex items-center gap-1.5">
              <input
                type="checkbox"
                className="accent-primary"
                checked={style.bold}
                onChange={(event) => set('bold', event.target.checked)}
              />
              Bold
            </label>
            <label className="flex items-center gap-1.5">
              <input
                type="checkbox"
                className="accent-primary"
                checked={style.uppercase}
                onChange={(event) => set('uppercase', event.target.checked)}
              />
              UPPERCASE
            </label>
          </div>
        </div>

        {error && (
          <p role="alert" className="text-destructive text-xs">
            {error}
          </p>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={close}>
            Cancel
          </Button>
          <Button onClick={() => void handleStart()} disabled={starting}>
            {starting ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Flame className="mr-2 h-4 w-4" />
            )}
            Burn in
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Label, control, and room underneath for what the control actually does. The
 * hint is where a setting says the part its name does not: that the playback
 * speed re-times the whole video, say, which nothing else on screen admits.
 *
 * The control is handed the hint's id rather than rendered beside it, so a
 * screen reader reads the warning as part of the field instead of leaving it
 * as loose text after the control it belongs to.
 */
function Field({
  id,
  label,
  hint,
  aside,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  aside?: string;
  children: (describedBy: string | undefined) => ReactNode;
}) {
  const hintId = hint ? `${id}-hint` : undefined;
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <Label htmlFor={id}>{label}</Label>
        {aside && <span className="text-muted-foreground text-xs tabular-nums">{aside}</span>}
      </div>
      {children(hintId)}
      {hint && (
        <p id={hintId} className="text-muted-foreground text-[11px]">
          {hint}
        </p>
      )}
    </div>
  );
}

function RangeField({
  id,
  label,
  hint,
  value,
  min,
  max,
  step,
  display,
  onChange,
}: {
  id: string;
  label: string;
  hint?: string;
  value: number;
  min: number;
  max: number;
  step: number;
  display: string;
  onChange: (value: number) => void;
}) {
  return (
    <Field id={id} label={label} hint={hint} aside={display}>
      {(describedBy) => (
        <input
          id={id}
          type="range"
          className="accent-primary w-full"
          aria-describedby={describedBy}
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(event) => onChange(Number(event.target.value))}
        />
      )}
    </Field>
  );
}

function ColorField({
  id,
  label,
  value,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <Field id={id} label={label}>
      {() => (
        <div className="flex items-center gap-2">
          <input
            id={id}
            type="color"
            className="h-8 w-10 cursor-pointer rounded border-0 bg-transparent p-0"
            value={value.toLowerCase()}
            onChange={(event) => onChange(event.target.value)}
          />
          <span className="text-muted-foreground text-xs uppercase tabular-nums">{value}</span>
        </div>
      )}
    </Field>
  );
}
