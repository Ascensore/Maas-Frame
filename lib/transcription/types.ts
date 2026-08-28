export type TranscriptWord = {
  start: number;
  end: number;
  text: string;
};

export type TranscriptCue = {
  start: number;
  end: number;
  speaker?: string;
  text: string;
  words: TranscriptWord[];
};

export type TranscriptionResult = {
  language: string;
  segments: TranscriptCue[];
};

export interface TranscriptionProvider {
  name: string;
  transcribe(input: { audioPath: string; language?: string }): Promise<TranscriptionResult>;
}
