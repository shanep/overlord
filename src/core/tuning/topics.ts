// Kinds of work the catalogs have skills and agents for, and the programs
// and file types that show a session doing that work. The Tuning view adds
// up the stack labels across sessions, picks the topics that stand out, and
// searches the catalogs with them.

import type { SessionMeasure } from './measure.js';
import { plural } from './words.js';

export interface Topic {
  readonly id: string;
  readonly label: string;
  /** What to search skills.sh for. */
  readonly query: string;
  /** Words in an agent's file name or group that mean it fits. */
  readonly words: readonly string[];
  /** Stack labels that show the work: programs and file extensions. */
  readonly signals: readonly string[];
}

export const TOPICS: readonly Topic[] = [
  {
    id: 'python',
    label: 'Python',
    query: 'python',
    words: ['python', 'django', 'fastapi', 'flask', 'pytest'],
    signals: ['.py', 'python', 'python3', 'pytest', 'pip', 'pip3', 'uv', 'poetry', 'ruff', 'mypy'],
  },
  {
    id: 'typescript',
    label: 'TypeScript',
    query: 'typescript',
    words: ['typescript', 'javascript', 'node', 'nodejs'],
    signals: ['.ts', '.tsx', '.mts', '.js', '.mjs', 'tsc', 'vitest', 'jest', 'eslint'],
  },
  {
    id: 'react',
    label: 'React',
    query: 'react',
    words: ['react', 'nextjs', 'frontend'],
    signals: ['.tsx', '.jsx'],
  },
  {
    id: 'rust',
    label: 'Rust',
    query: 'rust',
    words: ['rust'],
    signals: ['.rs', 'cargo', 'rustc'],
  },
  {
    id: 'go',
    label: 'Go',
    query: 'golang',
    words: ['go', 'golang'],
    signals: ['.go', 'go', 'gofmt'],
  },
  {
    id: 'java',
    label: 'Java',
    query: 'java',
    words: ['java', 'spring', 'springboot'],
    signals: ['.java', 'mvn', 'gradle', 'gradlew', 'java', 'javac'],
  },
  {
    id: 'dotnet',
    label: 'C# and .NET',
    query: 'dotnet',
    words: ['csharp', 'dotnet'],
    signals: ['.cs', '.csproj', '.sln', 'dotnet'],
  },
  {
    id: 'cpp',
    label: 'C and C++',
    query: 'c++',
    words: ['cpp', 'c'],
    signals: ['.c', '.h', '.cpp', '.hpp', '.cc', 'gcc', 'g++', 'clang', 'cmake', 'gdb', 'valgrind'],
  },
  {
    id: 'latex',
    label: 'LaTeX',
    query: 'latex',
    words: ['latex', 'tex', 'academic', 'research'],
    signals: ['.tex', '.bib', '.cls', 'latexmk', 'pdflatex', 'xelatex', 'lualatex', 'bibtex'],
  },
  {
    id: 'docker',
    label: 'Docker',
    query: 'docker',
    words: ['docker', 'container', 'containers'],
    signals: ['docker', 'docker-compose', 'Dockerfile', 'podman'],
  },
  {
    id: 'kubernetes',
    label: 'Kubernetes',
    query: 'kubernetes',
    words: ['kubernetes', 'k8s', 'helm'],
    signals: ['kubectl', 'helm', 'k9s', 'minikube', 'kind'],
  },
  {
    id: 'terraform',
    label: 'Terraform',
    query: 'terraform',
    words: ['terraform', 'iac'],
    signals: ['terraform', '.tf', 'tofu'],
  },
  {
    id: 'cloud',
    label: 'Cloud',
    query: 'aws',
    words: ['aws', 'cloud', 'azure', 'gcp'],
    signals: ['aws', 'az', 'gcloud', 'cdk', 'sam'],
  },
  {
    id: 'sql',
    label: 'SQL databases',
    query: 'sql',
    words: ['sql', 'postgres', 'postgresql', 'database', 'sqlite', 'mysql'],
    signals: ['.sql', 'psql', 'mysql', 'sqlite3', 'pg_dump'],
  },
  {
    id: 'shell',
    label: 'Shell scripts',
    query: 'bash',
    words: ['bash', 'shell'],
    signals: ['.sh', '.bash', '.zsh', 'shellcheck'],
  },
  {
    id: 'swift',
    label: 'Swift',
    query: 'swift',
    words: ['swift', 'ios', 'swiftui'],
    signals: ['.swift', 'swift', 'xcodebuild'],
  },
  {
    id: 'kotlin',
    label: 'Kotlin',
    query: 'kotlin',
    words: ['kotlin', 'android'],
    signals: ['.kt', '.kts'],
  },
  {
    id: 'ruby',
    label: 'Ruby',
    query: 'ruby',
    words: ['ruby', 'rails'],
    signals: ['.rb', 'ruby', 'bundle', 'rails', 'rake', 'Gemfile'],
  },
  {
    id: 'php',
    label: 'PHP',
    query: 'php',
    words: ['php', 'laravel'],
    signals: ['.php', 'php', 'composer'],
  },
  {
    id: 'pdf',
    label: 'PDF files',
    query: 'pdf',
    words: ['pdf'],
    signals: ['.pdf', 'pdftotext', 'qpdf', 'pdfinfo'],
  },
  {
    id: 'word',
    label: 'Word documents',
    query: 'docx',
    words: ['docx', 'word'],
    signals: ['.docx', 'pandoc'],
  },
  {
    id: 'spreadsheets',
    label: 'Spreadsheets',
    query: 'xlsx',
    words: ['xlsx', 'excel', 'spreadsheet', 'csv'],
    signals: ['.xlsx', '.csv'],
  },
  {
    id: 'slides',
    label: 'Slide decks',
    query: 'pptx',
    words: ['pptx', 'powerpoint', 'slides'],
    signals: ['.pptx'],
  },
  {
    id: 'notebooks',
    label: 'Jupyter notebooks',
    query: 'jupyter',
    words: ['jupyter', 'notebook', 'data'],
    signals: ['.ipynb', 'jupyter'],
  },
];

/** A topic has to show up in this many sessions to count, so one odd session does not. */
export const MIN_SESSIONS = 3;
/** And this many uses in all. */
export const MIN_USES = 20;
export const MAX_TOPICS = 4;

/** A topic that stands out in the sessions, with the counts behind it. */
export interface TopicScore {
  readonly topic: Topic;
  readonly uses: number;
  readonly sessions: number;
  /** The signals that showed it, most used first, with their counts. */
  readonly top: readonly (readonly [string, number])[];
}

function scoreOf(topic: Topic, measures: readonly SessionMeasure[]): TopicScore {
  const bySignal = new Map<string, number>();
  let sessions = 0;
  for (const measure of measures) {
    let used = false;
    for (const signal of topic.signals) {
      const count = measure.stack[signal] ?? 0;
      if (count > 0) {
        used = true;
        bySignal.set(signal, (bySignal.get(signal) ?? 0) + count);
      }
    }
    sessions += used ? 1 : 0;
  }
  const top = [...bySignal].toSorted((left, right) => right[1] - left[1]);
  const uses = top.reduce((total, [, count]) => total + count, 0);
  return { topic, uses, sessions, top };
}

/** The topics the sessions show most, at most MAX_TOPICS. */
export function topTopics(measures: readonly SessionMeasure[]): TopicScore[] {
  return TOPICS.map((topic) => scoreOf(topic, measures))
    .filter((score) => score.sessions >= MIN_SESSIONS && score.uses >= MIN_USES)
    .toSorted((left, right) => right.uses - left.uses)
    .slice(0, MAX_TOPICS);
}

function signalText([signal, count]: readonly [string, number]): string {
  if (signal.startsWith('.')) {
    return plural(count, `${signal} file read or edit`, `${signal} file reads or edits`);
  }
  // A file with no extension, such as a Dockerfile.
  if (/^[A-Z]/u.test(signal)) {
    return plural(count, `${signal} read or edit`, `${signal} reads or edits`);
  }
  return plural(count, `${signal} command`);
}

/** "1,203 .py file reads or edits and 412 pytest commands in 38 sessions." */
export function topicReason(score: TopicScore): string {
  const parts = score.top.slice(0, 2).map((entry) => signalText(entry));
  return `${parts.join(' and ')} in ${plural(score.sessions, 'session')}.`;
}
