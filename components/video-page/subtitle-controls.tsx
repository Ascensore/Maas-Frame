'use client';

import { memo, useCallback, useMemo, useRef, useState } from 'react';
import { Captions, Loader2, Sparkles, Trash2, Upload } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';
import { getSubtitleExtension } from '@/lib/subtitle-validation';
import { getTranscriptUploadExtension } from '@/lib/transcript-import';
import type { SubtitleTrackOption } from '@/components/video-page/types';

const COMMON_LANGUAGES = [
  'tr',
  'en',
  'de',
  'fr',
  'es',
  'it',
  'pt',
  'nl',
  'pl',
  'ru',
  'ar',
  'ja',
  'ko',
  'zh',
  'hi',
] as const;

const OTHER_LANGUAGE = '__other__';

/** A file named `cut-v3.tr.srt` already says which language it is. */
const LANGUAGE_FROM_FILENAME = /\.([a-z]{2,3}(?:-[a-z0-9]{2,8}){0,3})\.(?:srt|vtt|txt|docx)$/i;

function describeLanguage(tag: string): string {
  try {
    const displayNames = new Intl.DisplayNames(undefined, { type: 'language' });
    return displayNames.of(tag) || tag.toUpperCase();
  } catch {
    return tag.toUpperCase();
  }
}

function guessLanguageFromFileName(fileName: string): string | null {
  const match = LANGUAGE_FROM_FILENAME.exec(fileName);
  return match ? match[1].toLowerCase() : null;
}

export function isPlayerSubtitleUpload(fileName: string): boolean {
  return Boolean(getSubtitleExtension(fileName) || getTranscriptUploadExtension(fileName));
}

interface SubtitleControlsProps {
  /**
   * What the menu lists. For a Bunny or R2 version these are the tracks uploaded to this
   * cut; for a YouTube version they are the captions the video already carries, which is
   * why the shape is narrower than a stored subtitle.
   */
  subtitles: SubtitleTrackOption[];
  activeSubtitleLanguage: string | null;
  onSelectSubtitleLanguage: (language: string | null) => void;
  canManageSubtitles: boolean;
  /**
   * AI generation needs a file-backed cut we can extract audio from. YouTube embeds
   * still get the button so it is discoverable; it is disabled with a reason.
   */
  canGenerateSubtitles: boolean;
  /**
   * Show the CC button even when the track list is still empty. Used for YouTube,
   * where captions load asynchronously through the iframe module API and would
   * otherwise leave the control missing until that probe succeeds.
   */
  alwaysShow?: boolean;
  onUploadSubtitle: (file: File, language: string, label: string) => Promise<string | null>;
  onDeleteSubtitle: (subtitleId: string) => Promise<string | null>;
  onGenerateSubtitles: (language: string) => Promise<string | null>;
  isUploadingSubtitle: boolean;
  isGeneratingSubtitles: boolean;
}

export const SubtitleControls = memo(function SubtitleControls({
  subtitles,
  activeSubtitleLanguage,
  onSelectSubtitleLanguage,
  canManageSubtitles,
  canGenerateSubtitles,
  alwaysShow = false,
  onUploadSubtitle,
  onDeleteSubtitle,
  onGenerateSubtitles,
  isUploadingSubtitle,
  isGeneratingSubtitles,
}: SubtitleControlsProps) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [generateOpen, setGenerateOpen] = useState(false);
  const [languageChoice, setLanguageChoice] = useState<string>('en');
  const [customLanguage, setCustomLanguage] = useState('');
  const [label, setLabel] = useState('');

  const activeSubtitle = useMemo(
    () => subtitles.find((subtitle) => subtitle.language === activeSubtitleLanguage) ?? null,
    [activeSubtitleLanguage, subtitles]
  );

  const resolvedLanguage = (
    languageChoice === OTHER_LANGUAGE ? customLanguage : languageChoice
  ).trim();

  const pendingIsCaptionFile = pendingFile
    ? Boolean(getSubtitleExtension(pendingFile.name))
    : false;

  const applyGuessedLanguage = useCallback((fileName: string) => {
    const guessed = guessLanguageFromFileName(fileName);
    const known = guessed && (COMMON_LANGUAGES as readonly string[]).includes(guessed);
    setLanguageChoice(known ? (guessed as string) : guessed ? OTHER_LANGUAGE : 'en');
    setCustomLanguage(known ? '' : (guessed ?? ''));
  }, []);

  const handleFileChosen = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0] ?? null;
      // Clearing the input lets the same file be picked again after a failed upload.
      event.target.value = '';
      if (!file) return;
      if (!isPlayerSubtitleUpload(file.name)) {
        toast.error('Upload a .srt, .vtt, .txt, or .docx file');
        return;
      }
      applyGuessedLanguage(file.name);
      setLabel('');
      setPendingFile(file);
    },
    [applyGuessedLanguage]
  );

  const handleUpload = useCallback(async () => {
    if (!pendingFile || !resolvedLanguage) return;
    const finalLabel = label.trim() || describeLanguage(resolvedLanguage);
    const error = await onUploadSubtitle(pendingFile, resolvedLanguage, finalLabel);
    if (error) {
      toast.error(error);
      return;
    }
    toast.success(pendingIsCaptionFile ? 'Subtitle added' : 'Transcript uploaded');
    setPendingFile(null);
  }, [label, onUploadSubtitle, pendingFile, pendingIsCaptionFile, resolvedLanguage]);

  const handleGenerate = useCallback(async () => {
    if (!resolvedLanguage) return;
    const error = await onGenerateSubtitles(resolvedLanguage);
    if (error) {
      toast.error(error);
      return;
    }
    toast.success('Generating subtitles with AI. Captions will appear on this player when ready.');
    setGenerateOpen(false);
  }, [onGenerateSubtitles, resolvedLanguage]);

  const handleDelete = useCallback(
    async (subtitle: SubtitleTrackOption) => {
      const error = await onDeleteSubtitle(subtitle.id);
      if (error) {
        toast.error(error);
        return;
      }
      toast.success(`${subtitle.label} removed`);
    },
    [onDeleteSubtitle]
  );

  const openUploadPicker = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const openGenerate = useCallback(() => {
    setLanguageChoice('en');
    setCustomLanguage('');
    setGenerateOpen(true);
  }, []);

  if (subtitles.length === 0 && !canManageSubtitles && !alwaysShow) return null;

  const replacesExisting = subtitles.some(
    (subtitle) => subtitle.language === resolvedLanguage.toLowerCase()
  );

  const chromeButtonClass = 'h-8 gap-1 text-xs text-[#F4F4F2] hover:text-white hover:bg-white/10';

  return (
    <>
      {canManageSubtitles && (
        <>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className={chromeButtonClass}
            onClick={openUploadPicker}
            disabled={isUploadingSubtitle}
            title="Upload a .srt, .vtt, .txt, or .docx file"
          >
            {isUploadingSubtitle ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Upload className="h-3.5 w-3.5" />
            )}
            Upload file
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className={chromeButtonClass}
            onClick={openGenerate}
            disabled={isGeneratingSubtitles || !canGenerateSubtitles}
            title={
              canGenerateSubtitles
                ? 'Generate subtitles with AI'
                : 'AI subtitles need an uploaded video file, not a YouTube embed'
            }
          >
            {isGeneratingSubtitles ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Sparkles className="h-3.5 w-3.5" />
            )}
            Generate AI
          </Button>
        </>
      )}

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant={activeSubtitle ? 'default' : 'ghost'}
            size="sm"
            className={cn(
              'h-8 gap-1 text-xs',
              activeSubtitle ? '' : 'text-[#F4F4F2] hover:text-white hover:bg-white/10'
            )}
            title="Captions"
          >
            <Captions className="h-3.5 w-3.5" />
            {activeSubtitle ? activeSubtitle.label : 'Captions'}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-[220px]">
          {canManageSubtitles && (
            <>
              <DropdownMenuItem onClick={openUploadPicker} disabled={isUploadingSubtitle}>
                <Upload className="h-3.5 w-3.5 mr-2" />
                Upload text file
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={openGenerate}
                disabled={isGeneratingSubtitles || !canGenerateSubtitles}
              >
                <Sparkles className="h-3.5 w-3.5 mr-2" />
                Generate with AI
              </DropdownMenuItem>
              <DropdownMenuSeparator />
            </>
          )}
          <DropdownMenuItem
            onClick={() => onSelectSubtitleLanguage(null)}
            className={cn(!activeSubtitleLanguage && 'font-bold text-primary')}
          >
            Off
          </DropdownMenuItem>
          {subtitles.length === 0 && (
            <DropdownMenuItem disabled>No captions on this video</DropdownMenuItem>
          )}
          {subtitles.map((subtitle) => (
            <DropdownMenuItem
              key={subtitle.id}
              onClick={() => onSelectSubtitleLanguage(subtitle.language)}
              className={cn(
                'flex items-center justify-between gap-2',
                subtitle.language === activeSubtitleLanguage && 'font-bold text-primary'
              )}
            >
              <span className="truncate">{subtitle.label}</span>
              {subtitle.canDelete && (
                <button
                  type="button"
                  aria-label={`Delete ${subtitle.label} subtitle`}
                  className="text-muted-foreground hover:text-destructive"
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    void handleDelete(subtitle);
                  }}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              )}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      <input
        ref={fileInputRef}
        type="file"
        accept=".srt,.vtt,.txt,.docx,text/vtt,text/plain,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        className="hidden"
        onChange={handleFileChosen}
      />

      <Dialog
        open={!!pendingFile}
        onOpenChange={(open) => {
          if (!open && !isUploadingSubtitle) setPendingFile(null);
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Upload text file</DialogTitle>
            <DialogDescription>
              {pendingIsCaptionFile
                ? `${pendingFile?.name} is attached to this version as captions. SRT files are converted to WebVTT on upload.`
                : `${pendingFile?.name} becomes the transcript for this version. Timed .srt/.vtt files also appear as captions.`}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <LanguageFields
              languageChoice={languageChoice}
              customLanguage={customLanguage}
              onLanguageChoice={setLanguageChoice}
              onCustomLanguage={setCustomLanguage}
            />

            {pendingIsCaptionFile && (
              <div className="space-y-2">
                <Label htmlFor="subtitle-label">Label</Label>
                <Input
                  id="subtitle-label"
                  value={label}
                  onChange={(event) => setLabel(event.target.value)}
                  placeholder={resolvedLanguage ? describeLanguage(resolvedLanguage) : 'English'}
                  maxLength={60}
                />
              </div>
            )}

            {pendingIsCaptionFile && replacesExisting && (
              <p className="text-xs text-muted-foreground">
                This version already has a track in that language. Uploading replaces it.
              </p>
            )}
          </div>

          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setPendingFile(null)}
              disabled={isUploadingSubtitle}
            >
              Cancel
            </Button>
            <Button
              onClick={() => void handleUpload()}
              disabled={isUploadingSubtitle || !resolvedLanguage}
            >
              {isUploadingSubtitle && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Upload
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={generateOpen}
        onOpenChange={(open) => {
          if (!open && !isGeneratingSubtitles) setGenerateOpen(false);
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Generate subtitles with AI</DialogTitle>
            <DialogDescription>
              If this version already has a transcript, the captions are built from it; otherwise we
              transcribe it first. Either way the result is a track you can turn on in the player.
            </DialogDescription>
          </DialogHeader>

          <LanguageFields
            languageChoice={languageChoice}
            customLanguage={customLanguage}
            onLanguageChoice={setLanguageChoice}
            onCustomLanguage={setCustomLanguage}
          />

          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setGenerateOpen(false)}
              disabled={isGeneratingSubtitles}
            >
              Cancel
            </Button>
            <Button
              onClick={() => void handleGenerate()}
              disabled={isGeneratingSubtitles || !resolvedLanguage || !canGenerateSubtitles}
            >
              {isGeneratingSubtitles && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Generate subtitles
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
});

function LanguageFields({
  languageChoice,
  customLanguage,
  onLanguageChoice,
  onCustomLanguage,
}: {
  languageChoice: string;
  customLanguage: string;
  onLanguageChoice: (value: string) => void;
  onCustomLanguage: (value: string) => void;
}) {
  return (
    <div className="space-y-2">
      <Label htmlFor="subtitle-language">Language</Label>
      <Select value={languageChoice} onValueChange={onLanguageChoice}>
        <SelectTrigger id="subtitle-language">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {COMMON_LANGUAGES.map((tag) => (
            <SelectItem key={tag} value={tag}>
              {describeLanguage(tag)}
            </SelectItem>
          ))}
          <SelectItem value={OTHER_LANGUAGE}>Other</SelectItem>
        </SelectContent>
      </Select>
      {languageChoice === OTHER_LANGUAGE && (
        <Input
          value={customLanguage}
          onChange={(event) => onCustomLanguage(event.target.value)}
          placeholder="Language tag, e.g. en-US"
          maxLength={20}
        />
      )}
    </div>
  );
}
