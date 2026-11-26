import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { promises as fs } from 'fs';
import * as path from 'path';
import { PDFDocument } from 'pdf-lib';
import { buildCombinedGuide } from './guide-combine';
import type { GuideManifest, GuideModule, GuideRelease } from './guide.types';

const RELEASE_TTL_MS = 5 * 60_000;
const GITHUB_API = 'https://api.github.com';
const FETCH_TIMEOUT_MS = 30_000;

/**
 * TAFSD-616: the Guide tile. The manual (tafs-software-manual, LaTeX) is built
 * by a GitHub Action there and published as assets on the latest release of
 * that private repo: every PDF plus manifest.json. This service reads that
 * release with a read-only token, caches it, and hands the files to the Guide
 * page. It never writes anything anywhere.
 */
@Injectable()
export class GuideService {
  private readonly logger = new Logger(GuideService.name);
  private release: { value: GuideRelease; at: number } | null = null;
  private releaseInFlight: Promise<GuideRelease> | null = null;
  /** `${tag}/${asset}` -> bytes, for the current tag only. */
  private readonly files = new Map<string, Promise<Buffer>>();

  constructor(private readonly config: ConfigService) {}

  private get repo(): string {
    return (this.config.get<string>('MANUAL_GITHUB_REPO') || 'TAFCS/tafs-software-manual').trim();
  }

  /**
   * Development only: a local `build/publish` folder from `make publish` in
   * tafs-software-manual, read instead of GitHub. Lets a manual author see a
   * change in the Guide tab before pushing it.
   */
  private get localDir(): string | null {
    const dir = (this.config.get<string>('MANUAL_LOCAL_DIR') || '').trim();
    return dir && this.config.get<string>('NODE_ENV') !== 'production' ? dir : null;
  }

  private token(): string {
    const token = (this.config.get<string>('MANUAL_GITHUB_TOKEN') || '').trim();
    if (!token) {
      throw new ServiceUnavailableException(
        'The guide is not set up yet: the server has no MANUAL_GITHUB_TOKEN to read the manual with.',
      );
    }
    return token;
  }

  private async github(path: string, accept = 'application/vnd.github+json'): Promise<Response> {
    const res = await fetch(`${GITHUB_API}${path}`, {
      headers: {
        Authorization: `Bearer ${this.token()}`,
        Accept: accept,
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'tafsync-guide',
      },
      // Asset downloads redirect to a signed storage URL. Follow it by hand so
      // the token is never sent to a host other than api.github.com.
      redirect: 'manual',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      if (!location) throw new ServiceUnavailableException('GitHub sent a redirect with no location');
      return fetch(location, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    }
    return res;
  }

  /** The latest published manual, cached for five minutes. */
  async getRelease(): Promise<GuideRelease> {
    if (this.release && Date.now() - this.release.at < RELEASE_TTL_MS) return this.release.value;
    if (!this.releaseInFlight) {
      this.releaseInFlight = this.loadRelease()
        .then((value) => {
          if (this.release?.value.tag !== value.tag) this.files.clear();
          this.release = { value, at: Date.now() };
          return value;
        })
        .catch((err) => {
          // A GitHub hiccup should not take the page down while an older copy works.
          if (this.release && !(err instanceof ServiceUnavailableException && /MANUAL_GITHUB_TOKEN/.test(err.message))) {
            this.logger.warn(`Could not refresh the manual release, serving ${this.release.value.tag}: ${err?.message ?? err}`);
            this.release.at = Date.now();
            return this.release.value;
          }
          throw err;
        })
        .finally(() => {
          this.releaseInFlight = null;
        });
    }
    return this.releaseInFlight;
  }

  private async loadRelease(): Promise<GuideRelease> {
    const local = this.localDir;
    if (local) {
      const manifest = JSON.parse(await fs.readFile(path.join(local, 'manifest.json'), 'utf8')) as GuideManifest;
      const names = await fs.readdir(local);
      return { tag: `local-${manifest.built_at}`, published_at: manifest.built_at, manifest, assets: new Map(names.map((n, i) => [n, i])) };
    }
    const res = await this.github(`/repos/${this.repo}/releases/latest`);
    if (res.status === 404) {
      throw new ServiceUnavailableException(
        'No manual has been published yet. The Publish manual PDFs workflow in tafs-software-manual publishes one on every push to main.',
      );
    }
    if (!res.ok) {
      throw new ServiceUnavailableException(`GitHub answered ${res.status} for the latest manual release`);
    }
    const body = (await res.json()) as {
      tag_name: string;
      published_at: string | null;
      assets: { id: number; name: string }[];
    };
    const assets = new Map(body.assets.map((a) => [a.name, a.id]));
    const manifestId = assets.get('manifest.json');
    if (!manifestId) throw new ServiceUnavailableException(`Release ${body.tag_name} has no manifest.json`);
    const manifestRes = await this.github(`/repos/${this.repo}/releases/assets/${manifestId}`, 'application/octet-stream');
    if (!manifestRes.ok) throw new ServiceUnavailableException(`Could not read manifest.json (${manifestRes.status})`);
    const manifest = (await manifestRes.json()) as GuideManifest;
    if (manifest.schema !== 1 || !Array.isArray(manifest.areas)) {
      throw new ServiceUnavailableException(`manifest.json schema ${manifest.schema} is not one this server reads`);
    }
    return { tag: body.tag_name, published_at: body.published_at, manifest, assets };
  }

  /** What the Guide page draws: sections in reading order, with files and page counts. */
  async contents() {
    const { tag, published_at, manifest } = await this.getRelease();
    return {
      tag,
      published_at,
      built_at: manifest.built_at,
      commit: manifest.commit,
      title: manifest.title,
      manual: manifest.manual,
      areas: manifest.areas,
    };
  }

  /** Every file name the manifest lists. Nothing outside this set is served. */
  private servable(manifest: GuideManifest): Set<string> {
    const names = new Set<string>([manifest.manual.file]);
    for (const area of manifest.areas) {
      names.add(area.pdf.file);
      for (const m of area.modules) {
        names.add(m.pdf.file);
        names.add(m.bare.file);
      }
    }
    return names;
  }

  async file(name: string): Promise<Buffer> {
    const release = await this.getRelease();
    if (!this.servable(release.manifest).has(name)) throw new NotFoundException(`No guide file called ${name}`);
    return this.asset(release, name);
  }

  private asset(release: GuideRelease, name: string): Promise<Buffer> {
    const key = `${release.tag}/${name}`;
    let pending = this.files.get(key);
    if (!pending) {
      pending = (async () => {
        const local = this.localDir;
        if (local) return fs.readFile(path.join(local, path.basename(name)));
        const id = release.assets.get(name);
        if (!id) throw new NotFoundException(`Release ${release.tag} is missing ${name}`);
        const res = await this.github(`/repos/${this.repo}/releases/assets/${id}`, 'application/octet-stream');
        if (!res.ok) throw new ServiceUnavailableException(`Could not download ${name} (${res.status})`);
        return Buffer.from(await res.arrayBuffer());
      })();
      pending.catch(() => this.files.delete(key));
      this.files.set(key, pending);
    }
    return pending;
  }

  /**
   * Several modules joined into one PDF: a cover and contents page, then each
   * module's bare build (no cover or contents of its own), in reading order
   * whatever order they were asked for, numbered straight through, with
   * bookmarks per area and module.
   */
  async combine(moduleIds: string[]): Promise<{ bytes: Uint8Array; pages: number }> {
    const release = await this.getRelease();
    const wanted = new Set(moduleIds);
    const known = new Set(release.manifest.areas.flatMap((a) => a.modules.map((m) => m.id)));
    const unknown = [...wanted].filter((id) => !known.has(id));
    if (unknown.length) throw new BadRequestException(`Not in the guide: ${unknown.join(', ')}`);

    const sections: { areaTitle: string; module: GuideModule; doc: PDFDocument }[] = [];
    for (const area of release.manifest.areas) {
      for (const module of area.modules) {
        if (!wanted.has(module.id)) continue;
        const bytes = await this.asset(release, module.bare.file);
        sections.push({ areaTitle: area.title, module, doc: await PDFDocument.load(bytes) });
      }
    }
    const bytes = await buildCombinedGuide(sections, {
      title: release.manifest.title,
      subtitle: sections.length === 1 ? sections[0].module.title : `${sections.length} selected sections`,
      date: new Date(),
    });
    const pages = (await PDFDocument.load(bytes)).getPageCount();
    return { bytes, pages };
  }
}
