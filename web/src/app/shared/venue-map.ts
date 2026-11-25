import { Component, ElementRef, computed, input, output, viewChild } from '@angular/core';
import { WaitColour } from '../core/models';

/** The one hard-coded "Kalyana Mandapam" template (SPEC-LITE §4), in a 1000×700 viewBox. */
interface Zone { id: string; name: string; x: number; y: number; w: number; h: number }
const ZONES: readonly Zone[] = [
  { id: 'hall', name: 'Main hall', x: 40, y: 40, w: 560, h: 420 },
  { id: 'stage', name: 'Stage', x: 170, y: 52, w: 300, h: 70 },
  { id: 'dining', name: 'Dining hall', x: 620, y: 40, w: 340, h: 300 },
  { id: 'bride', name: "Bride's room", x: 620, y: 360, w: 165, h: 100 },
  { id: 'groom', name: "Groom's room", x: 795, y: 360, w: 165, h: 100 },
  { id: 'foyer', name: 'Foyer', x: 40, y: 480, w: 920, h: 100 },
  { id: 'parking', name: 'Parking', x: 40, y: 600, w: 920, h: 80 },
];

export interface MapPin {
  id: number;
  name: string;
  x: number; // % of width
  y: number; // % of height
  colour: WaitColour;
  label: string; // badge text, e.g. "12m"
}

const FILL: Record<WaitColour, string> = { green: '#1f7a3a', amber: '#b45309', red: '#b91c1c', grey: '#6b7280' };
const W = 1000;
const H = 700;

@Component({
  selector: 'app-venue-map',
  template: `
    <svg
      #svg viewBox="0 0 1000 700" class="themed block h-auto w-full select-none"
      [class.cursor-crosshair]="placing()"
      role="img" [attr.aria-label]="'Venue map with ' + pins().length + ' booths'"
      (click)="onMapClick($event)">
      <rect x="0" y="0" width="1000" height="700" rx="24" fill="var(--surface)" />
      @for (z of zones; track z.id) {
        <g [attr.opacity]="dimmed().has(z.id) ? 0.35 : 1">
          <rect
            [attr.x]="z.x" [attr.y]="z.y" [attr.width]="z.w" [attr.height]="z.h" rx="14"
            fill="var(--bg)" stroke="var(--primary)" stroke-opacity="0.45" stroke-width="2"
            [attr.stroke-dasharray]="z.id === 'parking' ? '10 8' : null" />
          <text
            [attr.x]="z.x + 14" [attr.y]="z.y + (z.id === 'stage' ? 42 : 30)"
            fill="var(--text)" fill-opacity="0.75" font-size="20" font-weight="600">{{ z.name }}</text>
        </g>
      }
      @for (p of pins(); track p.id) {
        <g
          class="cursor-pointer" role="button" tabindex="0"
          [attr.aria-label]="p.name + ', ' + p.label"
          [attr.aria-pressed]="p.id === selectedId()"
          [attr.transform]="'translate(' + (p.x * 10) + ' ' + (p.y * 7) + ')'"
          (click)="pick(p.id, $event)" (keydown.enter)="pick(p.id, $event)" (keydown.space)="pick(p.id, $event)">
          @if (p.id === selectedId()) {
            <circle r="46" fill="none" stroke="var(--accent)" stroke-width="6" />
          }
          <circle r="36" [attr.fill]="fill[p.colour]" stroke="#fff" stroke-width="5" />
          <text text-anchor="middle" dy="9" fill="#fff" font-size="26" font-weight="700">{{ p.label }}</text>
          <text text-anchor="middle" y="68" fill="var(--text)" font-size="26" font-weight="700"
                paint-order="stroke" stroke="var(--bg)" stroke-width="6">{{ p.name }}</text>
        </g>
      }
    </svg>
  `,
})
export class VenueMap {
  readonly pins = input.required<MapPin[]>();
  readonly selectedId = input<number | null>(null);
  /** Dim zones that hold no pin (guest map: zones not used by the live event). */
  readonly dimUnused = input(false);
  /** Admin layout: clicks on the map report a position. */
  readonly placing = input(false);

  readonly boothClick = output<number>();
  readonly place = output<{ x: number; y: number }>();

  protected readonly zones = ZONES;
  protected readonly fill = FILL;
  private readonly svg = viewChild.required<ElementRef<SVGSVGElement>>('svg');

  protected readonly dimmed = computed(() => {
    if (!this.dimUnused()) return new Set<string>();
    const used = new Set<string>();
    for (const p of this.pins()) {
      const x = p.x * 10;
      const y = p.y * 7;
      for (const z of ZONES) if (x >= z.x && x <= z.x + z.w && y >= z.y && y <= z.y + z.h) used.add(z.id);
    }
    return new Set(ZONES.filter((z) => !used.has(z.id)).map((z) => z.id));
  });

  protected pick(id: number, e: Event): void {
    e.stopPropagation();
    e.preventDefault();
    this.boothClick.emit(id);
  }

  protected onMapClick(e: MouseEvent): void {
    if (!this.placing()) return;
    const svg = this.svg().nativeElement;
    const ctm = svg.getScreenCTM();
    if (!ctm) return;
    const pt = new DOMPoint(e.clientX, e.clientY).matrixTransform(ctm.inverse());
    const clamp = (v: number) => Math.round(Math.min(100, Math.max(0, v)) * 10) / 10;
    this.place.emit({ x: clamp((pt.x / W) * 100), y: clamp((pt.y / H) * 100) });
  }
}

/** Pin for a booth summary. */
export function boothPin(b: { id: number; name: string; x: number; y: number; colour: WaitColour; paused: boolean; waitMin: number }): MapPin {
  return { id: b.id, name: b.name, x: b.x, y: b.y, colour: b.colour, label: b.paused ? '❚❚' : `${b.waitMin}m` };
}
