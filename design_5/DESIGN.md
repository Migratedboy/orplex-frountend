---
name: Vivid Catalyst
colors:
  surface: '#f9f9fa'
  surface-dim: '#dadadb'
  surface-bright: '#f9f9fa'
  surface-container-lowest: '#ffffff'
  surface-container-low: '#f3f3f4'
  surface-container: '#eeeeef'
  surface-container-high: '#e8e8e9'
  surface-container-highest: '#e2e2e3'
  on-surface: '#1a1c1d'
  on-surface-variant: '#5a4136'
  inverse-surface: '#2f3132'
  inverse-on-surface: '#f0f1f2'
  outline: '#8e7164'
  outline-variant: '#e2bfb0'
  surface-tint: '#a04100'
  primary: '#a04100'
  on-primary: '#ffffff'
  primary-container: '#ff6b00'
  on-primary-container: '#572000'
  inverse-primary: '#ffb693'
  secondary: '#5f5e5e'
  on-secondary: '#ffffff'
  secondary-container: '#e2dfde'
  on-secondary-container: '#636262'
  tertiary: '#944b00'
  on-tertiary: '#ffffff'
  tertiary-container: '#dd8339'
  on-tertiary-container: '#502600'
  error: '#ba1a1a'
  on-error: '#ffffff'
  error-container: '#ffdad6'
  on-error-container: '#93000a'
  primary-fixed: '#ffdbcc'
  primary-fixed-dim: '#ffb693'
  on-primary-fixed: '#351000'
  on-primary-fixed-variant: '#7a3000'
  secondary-fixed: '#e5e2e1'
  secondary-fixed-dim: '#c8c6c5'
  on-secondary-fixed: '#1c1b1b'
  on-secondary-fixed-variant: '#474746'
  tertiary-fixed: '#ffdcc5'
  tertiary-fixed-dim: '#ffb783'
  on-tertiary-fixed: '#301400'
  on-tertiary-fixed-variant: '#703700'
  background: '#f9f9fa'
  on-background: '#1a1c1d'
  surface-variant: '#e2e2e3'
  surface-pure: '#FFFFFF'
  surface-subtle: '#F9FAFB'
  border-light: '#E4E4E7'
  accent-warm: '#FFF7ED'
typography:
  display-lg:
    fontFamily: Lexend
    fontSize: 64px
    fontWeight: '700'
    lineHeight: '1.1'
    letterSpacing: -0.03em
  headline-lg:
    fontFamily: Lexend
    fontSize: 32px
    fontWeight: '600'
    lineHeight: '1.2'
  headline-lg-mobile:
    fontFamily: Lexend
    fontSize: 24px
    fontWeight: '600'
    lineHeight: '1.2'
  body-md:
    fontFamily: Lexend
    fontSize: 16px
    fontWeight: '400'
    lineHeight: '1.6'
  code-md:
    fontFamily: JetBrains Mono
    fontSize: 14px
    fontWeight: '450'
    lineHeight: '1.5'
  label-sm:
    fontFamily: JetBrains Mono
    fontSize: 11px
    fontWeight: '500'
    lineHeight: '1.2'
    letterSpacing: 0.05em
  label-caps:
    fontFamily: JetBrains Mono
    fontSize: 10px
    fontWeight: '700'
    lineHeight: '1'
    letterSpacing: 0.15em
rounded:
  sm: 0.125rem
  DEFAULT: 0.25rem
  md: 0.375rem
  lg: 0.5rem
  xl: 0.75rem
  full: 9999px
spacing:
  unit: 4px
  gutter: 24px
  margin-sm: 16px
  margin-md: 32px
  margin-lg: 64px
  container-max: 1280px
---

## Brand & Style

The design system embodies a **High-Fidelity Technical** aesthetic, blending the precision of professional engineering tools with the energy of a modern startup. It targets power users who require a high-density, performant interface that doesn't sacrifice visual excitement.

The design style is a sophisticated **Minimalism** with a **Tactile** edge. It utilizes a vast amount of white space and a crisp "Light Mode" foundation to ensure maximum legibility and mental clarity. The "Vibrant Orange" serves as a high-energy catalyst, drawing the eye to critical paths and interactive nodes. The atmosphere is clean, optimistic, and relentlessly professional, evoking the feeling of a well-organized, high-tech laboratory.

## Colors

The palette is anchored by a high-chroma orange and a clinical white base, creating a stark, high-contrast environment.

- **Primary (Vibrant Orange):** The core driver of the brand. Used exclusively for primary actions, success states, and meaningful highlights. It should feel saturated and energetic.
- **Secondary (Technical Black):** Used for primary typography and structural elements where high contrast is required. It provides the "technical" weight to balance the orange.
- **Neutral (Cool Gray):** A scale of grays used for UI scaffolding, borders, and secondary text to prevent the interface from feeling "washed out."
- **Background Strategy:** Surfaces are predominantly `#FFFFFF`. Depth is created using subtle off-white shifts (`#F9FAFB`) and light gray borders rather than shadows.

## Typography

This system utilizes **Lexend** as its primary typographic voice. Its geometric, hyper-legible structure is essential for maintaining the "Technical" aesthetic while feeling approachable.

- **Lexend:** Applied to all headings, body copy, and primary navigation. Use heavier weights (`600`+) for headings in `secondary_color_hex` to ground the page.
- **JetBrains Mono:** Retained as a secondary "Utility" font. It is used for metadata, code snippets, and system labels. This creates a clear visual distinction between human-readable content and machine-driven data.
- **Scale:** High contrast in size between display text and body copy is encouraged to create a strong editorial hierarchy.

## Layout & Spacing

The layout philosophy follows a **Fixed Grid** model for structure, ensuring a predictable and organized technical environment.

- **Structure:** A 12-column grid with a generous 24px gutter. On desktop, content is centered within a 1280px container.
- **Rhythm:** A strict 4px baseline grid. All heights, paddings, and margins must be multiples of 4px.
- **Density:** Maintain high density for toolbars and data tables (using 8px/12px padding), while allowing "breathes" in content-heavy areas with 32px+ margins.
- **Mobile Adaptivity:** Breakpoints at 768px (Tablet) and 480px (Mobile). On mobile, gutters collapse to 16px and the 12-column grid shifts to a 4-column layout.

## Elevation & Depth

Hierarchy is established through **Low-contrast outlines** and **Tonal Layering** rather than traditional shadows.

- **Flat Foundation:** The base layer is white. Secondary panels use a light gray (`#F4F4F5`) fill with no border.
- **Ghost Borders:** Elements are separated by 1px solid borders in `#E4E4E7`. 
- **Active Elevation:** Only the most critical floating elements (Modals, Popovers) receive a shadow. These shadows should be "Ambient"—highly diffused, using the `secondary_color_hex` at 5% opacity.
- **The "Lift":** When an item is hovered, instead of a shadow, it should receive a subtle 1px border of `primary_color_hex` or a very faint orange wash (`accent-warm`).

## Shapes

The shape language is **Soft (0.25rem)**, emphasizing a modern, engineered feel that avoids the "playfulness" of overly rounded corners.

- **Base Components:** Buttons, inputs, and tags use a `0.25rem` radius. This provides just enough softness to feel modern while remaining sharp and professional.
- **Large Containers:** Cards and modals may use `rounded-lg` (0.5rem) to signify they are larger structural buckets.
- **Interactive States:** Maintain consistent corner radii across all states to ensure the UI feels stable and mechanical.

## Components

- **Buttons:** Primary buttons are solid `primary_color_hex` with white text. Secondary buttons use a white background with a 1px `secondary_color_hex` border.
- **Input Fields:** Use a white background with a 1px `#E4E4E7` border. On focus, the border changes to `primary_color_hex` with a 2px outer ring of the same color at 10% opacity.
- **Chips:** Small, technical badges using `label-caps` typography. Use a light gray background with black text, or an orange background with white text for "Active" status.
- **Lists:** Clean rows separated by 1px horizontal dividers. Use a subtle orange left-accent bar (4px width) to indicate the selected item in a list.
- **Cards:** White background, 1px border in `#E4E4E7`. No shadow. Use `headline-lg` for card titles to ensure strong internal hierarchy.
- **Checkboxes & Radios:** When checked, these should be solid `primary_color_hex`. The "tick" or "dot" should be white.