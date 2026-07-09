import { Injectable, computed, effect, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { MediaService, MediaFileNode, MediaFolder, MediaNode } from './media.service';
import { WatchHistoryService, WatchHistoryEntry } from './watch-history.service';
import { ProcessingTrackerService } from './processing-tracker.service';
import { ListService } from './list.service';
import { BACKEND_BASE } from '../../../env-cast';

export type RailKind = 'film' | 'series';

/** A horizontal browse row on the home screen. */
export type Rail = { title: string; files: MediaFileNode[]; kind: RailKind; key: string };

/** Which browse section is active (drives nav highlighting + rail filtering). */
export type NavFilter = 'home' | 'films' | 'series' | 'list';

/** A Continue Watching shelf entry joined to its library file. */
export type ContinueItem = { file: MediaFileNode; entry: WatchHistoryEntry };

/**
 * Owns the library tree and everything derived from it (rails, hero pick, continue-watching,
 * poster art, episode adjacency). Split out of HomeComponent so the nav/hero/rail/tile/player
 * components can all read one source instead of prop-drilling.
 */
@Injectable({ providedIn: 'root' })
export class LibraryService {
  private media        = inject(MediaService);
  private watchHistory = inject(WatchHistoryService);
  private tracker      = inject(ProcessingTrackerService);
  private listSvc      = inject(ListService);

  tree = toSignal(this.media.list(), { initialValue: [] as MediaNode[] });
  continueWatchingItems = signal<ContinueItem[]>([]);

  // Active browse section, and the focused title (detail page); both drive the shell's view.
  navFilter = signal<NavFilter>('home');
  focused   = signal<MediaFileNode | null>(null);

  // Paths on the user's "Minha lista" (backend-persisted).
  listPaths = signal<Set<string>>(new Set());

  // URLs whose thumbnail failed to load — rendered as a placeholder instead of a broken <img>,
  // and never retried, so a missing/failed frame never shows a broken-link icon.
  thumbFailed = signal<Set<string>>(new Set());

  constructor() {
    // Refresh the Continue Watching shelf and My List once the library tree is available.
    effect(() => {
      if (this.tree().length > 0) { this.loadContinueWatching(); this.loadList(); }
    });
  }

  // The hero features the most recent continue-watching title, falling back to the first file
  // in the library so the home never renders an empty hero.
  featuredFile = computed<MediaFileNode | null>(() => {
    const cw = this.continueWatchingItems();
    if (cw.length) return cw[0].file;
    return this.allFileNodes()[0] ?? null;
  });

  // Rails derived from the real library layout (root D:/Media):
  //   Movies/<Collection>/…  → one FILM rail per collection folder (Harry Potter, Others…);
  //   Movies/<file>          → a standalone film, gathered into a leading "Filmes" rail;
  //   Series/<Show>/Season N → one SERIES rail per season ("Dexter · Season 1");
  //   Series/<Show>/<file>   → a single-season SERIES rail titled with the show name.
  // Files within each rail are natural-sorted (S1E2 before S1E10).
  libraryRails = computed<Rail[]>(() => {
    const rails: Rail[] = [];
    const looseFilms: MediaFileNode[] = [];

    for (const node of this.tree()) {
      if (node.type === 'file') { looseFilms.push(node); continue; }
      const seg = node.name.toLowerCase();

      if (seg === 'movies') {
        for (const child of node.children) {
          if (child.type === 'folder') {
            const files = this.sortFiles(this.collectFiles(child));
            if (files.length) rails.push({ title: child.name, files, kind: 'film', key: child.path });
          } else {
            looseFilms.push(child);
          }
        }
      } else if (seg === 'series') {
        for (const show of node.children) {
          if (show.type === 'folder') rails.push(...this.buildSeriesRails(show));
          else looseFilms.push(show);
        }
      } else {
        // Unknown top-level folder: treat like a series (its subfolders become season rails).
        rails.push(...this.buildSeriesRails(node));
      }
    }

    if (looseFilms.length) {
      rails.unshift({ title: 'Filmes', files: this.sortFiles(looseFilms), kind: 'film', key: '__films__' });
    }
    return rails;
  });

  private buildSeriesRails(show: MediaFolder): Rail[] {
    const rails: Rail[] = [];
    const directFiles: MediaFileNode[] = [];
    const seasons: MediaFolder[] = [];
    for (const c of show.children) {
      if (c.type === 'folder') seasons.push(c);
      else directFiles.push(c);
    }
    // Single-season shows keep their files directly under the show folder.
    if (directFiles.length) {
      rails.push({ title: show.name, files: this.sortFiles(directFiles), kind: 'series', key: show.path });
    }
    for (const season of seasons) {
      const files = this.sortFiles(this.collectFiles(season));
      if (files.length) rails.push({ title: `${show.name} · ${season.name}`, files, kind: 'series', key: season.path });
    }
    return rails;
  }

  // Rails filtered by the active nav section (Films / Series). List has its own grid.
  visibleRails = computed<Rail[]>(() => {
    const rails = this.libraryRails();
    switch (this.navFilter()) {
      case 'films':  return rails.filter(r => r.kind === 'film');
      case 'series': return rails.filter(r => r.kind === 'series');
      default:       return rails;   // 'home'
    }
  });

  collectFiles(folder: MediaNode): MediaFileNode[] {
    if (folder.type === 'file') return [folder];
    return folder.children.flatMap(c => this.collectFiles(c));
  }

  private sortFiles(files: MediaFileNode[]): MediaFileNode[] {
    return [...files].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
  }

  // First path segment classifies a title: Movies/* = film, Series/* = series.
  pathKind(path: string | null | undefined): RailKind | null {
    if (!path) return null;
    const seg = path.split('/')[0]?.toLowerCase();
    if (seg === 'movies') return 'film';
    if (seg === 'series') return 'series';
    return null;
  }

  // Sibling files in the same folder (season for a series, collection for a movie franchise).
  siblingsOf(path: string): MediaFileNode[] {
    const find = (children: MediaNode[]): MediaFileNode[] | null => {
      if (children.some(n => n.type === 'file' && n.path === path)) {
        return children.filter(n => n.type === 'file') as MediaFileNode[];
      }
      for (const n of children) {
        if (n.type === 'folder') { const r = find(n.children); if (r) return r; }
      }
      return null;
    };
    return this.sortFiles(find(this.tree()) ?? []);
  }

  openFocus(node: MediaFileNode) { this.focused.set(node); }
  closeFocus() { this.focused.set(null); }

  // Name of the folder directly containing `path` — shown as the player's "series" subline.
  // Null for top-level standalone titles.
  seriesLabelFor(path: string | null | undefined): string | null {
    if (!path) return null;
    const find = (nodes: MediaNode[], parent: string | null): string | null => {
      for (const n of nodes) {
        if (n.type === 'file') { if (n.path === path) return parent; }
        else { const r = find(n.children, n.name); if (r) return r; }
      }
      return null;
    };
    return find(this.tree(), null);
  }

  // Poster/backdrop art for a library file — a mid-ish frame reads better as key art than
  // frame 0 (often black). Missing/unprocessed files fail the <img> and fall back to a tile.
  posterSrc(node: MediaFileNode): string {
    return `${BACKEND_BASE}${node.thumbUrl}?t=60`;
  }

  fileNameFor(path: string): string {
    return this.allFileNodes().find(f => f.path === path)?.name ?? path;
  }

  jobForPath(path: string) {
    return this.tracker.jobs().find(j => j.path === path && j.jobType === 'main');
  }

  async preprocessFile(node: MediaFileNode) {
    await this.media.preprocess(node.path);
  }

  async deleteCache(node: MediaFileNode) {
    await this.media.deleteCache(node.path);
    node.ready = false;
    node.cachedBytes = 0;
  }

  onThumbError(url: string) {
    this.thumbFailed.update(set => {
      if (set.has(url)) return set;
      const next = new Set(set);
      next.add(url);
      return next;
    });
  }

  allFileNodes(): MediaFileNode[] {
    const result: MediaFileNode[] = [];
    const walk = (nodes: MediaNode[]) => {
      for (const node of nodes) {
        if (node.type === 'folder') walk(node.children);
        else result.push(node);
      }
    };
    walk(this.tree());
    return result;
  }

  /**
   * Locate the adjacent episode: the previous (dir -1) or next (dir +1) file among `path`'s
   * sibling files in the same folder. Only searches within folders — top-level files are
   * standalone titles, not a series, so they never chain into one another.
   */
  findAdjacentEpisode(path: string, dir: 1 | -1): MediaFileNode | null {
    const searchFolder = (children: MediaNode[]): MediaFileNode | null => {
      const idx = children.findIndex(n => n.type === 'file' && n.path === path);
      if (idx !== -1) {
        for (let i = idx + dir; i >= 0 && i < children.length; i += dir) {
          if (children[i].type === 'file') return children[i] as MediaFileNode;
        }
        return null; // first/last episode in this folder
      }
      for (const n of children) {
        if (n.type === 'folder') {
          const found = searchFolder(n.children);
          if (found) return found;
        }
      }
      return null;
    };
    for (const n of this.tree()) {
      if (n.type === 'folder') {
        const found = searchFolder(n.children);
        if (found) return found;
      }
    }
    return null;
  }

  // Cap the Continue Watching shelf — more than this is just noise.
  private readonly CONTINUE_WATCHING_MAX = 10;

  async loadContinueWatching() {
    const rows  = await this.watchHistory.continueWatching();
    const files = this.allFileNodes();
    const items = rows
      // Drop finished titles (≥95% watched) client-side too, so a just-completed title leaves
      // the shelf immediately on return — the backend applies the same rule on its next query.
      .filter(e => !(e.durationSeconds > 0 && e.positionSeconds >= e.durationSeconds * 0.95))
      .map(entry => ({ entry, file: files.find(f => f.path === entry.path) }))
      .filter((x): x is ContinueItem => !!x.file)
      .slice(0, this.CONTINUE_WATCHING_MAX);   // most-recent 10 (rows arrive newest-first)
    this.continueWatchingItems.set(items);
  }

  // ── My List ──────────────────────────────────────────────────────────────────

  listItems = computed<MediaFileNode[]>(() => {
    const paths = this.listPaths();
    return this.allFileNodes().filter(f => paths.has(f.path));
  });

  inList(node: MediaFileNode): boolean {
    return this.listPaths().has(node.path);
  }

  async loadList() {
    const paths = await this.listSvc.getAll();
    this.listPaths.set(new Set(paths));
  }

  /** Optimistically toggle list membership, then persist. */
  toggleList(node: MediaFileNode, e?: Event) {
    e?.stopPropagation();
    const path = node.path;
    const has = this.listPaths().has(path);
    this.listPaths.update(set => {
      const next = new Set(set);
      has ? next.delete(path) : next.add(path);
      return next;
    });
    (has ? this.listSvc.remove(path) : this.listSvc.add(path)).catch(() => this.loadList());
  }
}
