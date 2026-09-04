/**
 * Content-Type for a file we send to a cloud STT API. OpenAI is audio-only;
 * video is never uploaded. Deepgram sniffs the name as well.
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

export function isAudioFileName(fileName: string): boolean {
  return mediaTypeFromFileName(fileName).startsWith('audio/');
}
