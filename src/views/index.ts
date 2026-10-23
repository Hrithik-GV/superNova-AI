import { getWebviewStyles } from './styles';
import { getWebviewHtmlBody } from './template';
import { getWebviewClientScript } from './clientScript';

/**
 * Assembles and returns the full HTML document for the Supernova AI webview.
 */
export function getWebviewContent(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
  <title>Supernova AI</title>
  <style>
${getWebviewStyles()}
  </style>
</head>
<body>
${getWebviewHtmlBody()}
  <script>
${getWebviewClientScript()}
  </script>
</body>
</html>`;
}

export { getWebviewStyles } from './styles';
export { getWebviewHtmlBody } from './template';
export { getWebviewClientScript } from './clientScript';
export { getQuizClientScript } from './quizScript';
