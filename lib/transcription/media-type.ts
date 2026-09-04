/**
 * Content-Type for a file we send to a cloud STT API. OpenAI and Deepgram both
 * sniff the name as well, but a hard-coded `audio/wav` on an `.mp4` made
 * Whisper reject WhatsApp videos that otherwise fit the 25 MiB cap.
 */
export function mediaTypeFromFileName(fileName: string): string {
  const ext = fileName.split('.').pop()?.toLowerCase() ?? '';
  switch (ext) {
    case 'mp4':
    case 'm4v':
      return 'video/mp4';
    case 'webm':
      return 'video/webm';
    case 'mp3':
      return 'audio/mpeg';
    case 'wav':
      return 'audio/wav';
    case 'm4a':
      return 'audio/mp4';
    case 'ogg':
    case 'oga':
      return 'audio/ogg';
    case 'flac':
      return 'audio/flac';
    case 'aac':
      return 'audio/aac';
    default:
      return 'application/octet-stream';
  }
}
