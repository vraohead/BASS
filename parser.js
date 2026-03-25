// parser.js — BASS - Booking Assistant v4.3
// ZERO secrets. Pure string parsing.
//
// KEY FIXES in this version:
//  1. Guest headers: match anything ending _Number_\d+ ONLY inside Customer Details section
//  2. Links: extract hrefs from raw HTML correctly regardless of tag wrapping between label and <a>
//  3. Instructions: flexible matching for any heading format, quoted or unquoted, bold or plain

function parseTicketHtml(htmlContent) {

  const DEFAULT = {
    ticketDetails: {
      productDetails:  { bookingId:'N/A', tourName:'N/A', tourGroupId:'N/A', city:'N/A', tourId:'N/A' },
      bookingDetails:  { date:'N/A', startTime:'N/A', guestNumbers:'N/A', finalPricePaid:'N/A', netPrice:'N/A', promoDiscount:'N/A' },
      customerDetails: { guests:[], rawHtml: null },
      postBookingInfo: { isCancellable:'N/A', cancellableUpto:'N/A', isReschedulable:'N/A', reschedulableUpto:'N/A', meetingPoint:'N/A', googleMapsUrl:'N/A', ticketValidity:'N/A', isInventoryAutomated:'N/A' },
      links:           { bmsLink:'N/A', ariesInventoryLink:'N/A' }
    },
    instructions: {
      importantInstructions: { summary:'', steps:[], richHtml: null },
      bookingInstructions:   { summary:'', steps:[], richHtml: null }
    }
  };

  if (!htmlContent || typeof htmlContent !== 'string') return DEFAULT;

  try {

    // ══════════════════════════════════════════════════════════════════════
    // HELPERS
    // ══════════════════════════════════════════════════════════════════════

    /**
     * Strip all HTML tags and decode entities.
     * Block-closing tags → newlines to preserve line structure.
     */
    const stripHtml = (s) =>
      s.replace(/<br\s*\/?>/gi, '\n')
       .replace(/<\/(?:p|div|li|tr|td|th|h[1-6])>/gi, '\n')
       .replace(/<[^>]+>/g, '')
       .replace(/&nbsp;/g, ' ')
       .replace(/&amp;/g, '&')
       .replace(/&lt;/g, '<')
       .replace(/&gt;/g, '>')
       .replace(/&quot;/g, '"')
       .replace(/&#39;/g, "'")
       .replace(/[ \t]+/g, ' ')
       .replace(/\n[ \t]+/g, '\n')
       .trim();

    // Plain text of the full comment
    const fullText = stripHtml(htmlContent);

    /**
     * Extract "Label: Value" from a plain-text block.
     * Stops at the next comma (for dense comma-separated lines) or newline.
     * _ and space are treated as interchangeable in label matching.
     */
    const extractInline = (text, label) => {
      const pat = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/[_ ]/g, '[_\\s]');
      const rx  = new RegExp(`${pat}\\s*:\\s*([^,\\n]+?)(?=\\s*,|\\n|$)`, 'i');
      const m   = text.match(rx);
      if (!m) return 'N/A';
      const v = m[1].trim().replace(/,\s*$/, '').replace(/:$/, '').trim();
      return v || 'N/A';
    };

    /**
     * Extract href from raw HTML for a given label.
     *
     * The core insight: Zendesk renders links like:
     *   BMS Link: <a href="https://aries.headout.com/bms/booking/28228130">https://aries.headout.com/bms/booking/28228130</a>
     *
     * The label and <a> tag may be:
     *  - On the same line
     *  - Separated by </p><p> or <br> tags (which add arbitrary HTML between them)
     *
     * Strategy:
     *  1. Find the label text position in the raw HTML
     *  2. From that position, scan forward up to 800 chars for the FIRST <a href="...">
     *  3. Also try: label is inside the <a> tag's link text
     *  4. Fallback: find plain URL after label in stripped text
     */
    const extractLink = (html, label) => {
      const pat = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/[_ ]/g, '[\\s_]{1,3}');

      // Strategy 1: label appears in text, then within 800 chars there's an <a href>
      // We use a window large enough to cross one or two HTML tags between label and link
      const rxA = new RegExp(
        `${pat}\\s*:?[\\s\\S]{0,800}?<a[\\s\\S]{0,200}?href=["']([^"'\\s>]+)["']`,
        'i'
      );
      const mA = rxA.exec(html);
      if (mA) {
        const url = mA[1].trim();
        // Sanity check: must be http(s) and not a mailto
        if (url.startsWith('http')) return url;
      }

      // Strategy 2: <a href> where the link TEXT contains the label
      // e.g. <a href="...">BMS Link</a>  — less common but possible
      const rxB = new RegExp(
        `<a[\\s\\S]{0,200}?href=["']([^"'\\s>]+)["'][\\s\\S]{0,200}?>${pat}[\\s\\S]{0,100}?<\\/a>`,
        'i'
      );
      const mB = rxB.exec(html);
      if (mB && mB[1].startsWith('http')) return mB[1].trim();

      // Strategy 3: plain URL in stripped text after the label
      const stripped = stripHtml(html);
      const rxC = new RegExp(`${pat}\\s*:?\\s*(https?:\\/\\/[^\\s,\\n"'<>]+)`, 'i');
      const mC = rxC.exec(stripped);
      if (mC) return mC[1].trim();

      return 'N/A';
    };

    /**
     * Extract customer email, skipping operational addresses.
     */
    const extractEmail = (text) => {
      const skipRx = /(?:Booking Intimation|Booking Escalation|Vendor|Supplier)\s*Email\s*:\s*([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})/gi;
      const skip = new Set();
      let sm;
      while ((sm = skipRx.exec(text)) !== null) skip.add(sm[1].toLowerCase());

      const labelRx = /\bEmail\s*:\s*([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})/i;
      const lm = text.match(labelRx);
      if (lm && !skip.has(lm[1].toLowerCase())) return lm[1].trim();

      for (const em of text.matchAll(/([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})/g)) {
        if (!skip.has(em[1].toLowerCase())) return em[1].trim();
      }
      return 'N/A';
    };

    // ══════════════════════════════════════════════════════════════════════
    // ZONE BOUNDARIES
    // Split the plain text into zones so we search the right region for each thing.
    //
    // fullText layout:
    //   Product Details ... Booking Details ... Vendor Details ...
    //   Customer Details ... Important Links ... Post booking information ...
    //   Important Instruction ... Booking Instruction ...
    //   ---- Vendor & Tour Info ----   ← STOP. Everything below is vendor-internal.
    // ══════════════════════════════════════════════════════════════════════

    // Find the Vendor & Tour Info divider
    const vendorDivRx = /[-]{3,}[^\n]*Vendor[^\n]*Tour[^\n]*Info[^\n]*[-]{3,}|--\s*Vendor\s*&?\s*Tour\s*Info/i;
    const vendorDivM  = vendorDivRx.exec(fullText);
    // agentText = everything the agent should see (before the vendor divider)
    const agentText   = vendorDivM ? fullText.slice(0, vendorDivM.index) : fullText;

    // Find the same cut position in raw HTML (using character-ratio approximation)
    const cutFraction = vendorDivM ? vendorDivM.index / fullText.length : 1;
    const agentHtml   = htmlContent.slice(0, Math.ceil(htmlContent.length * cutFraction));

    // Find Customer Details section start in agentText
    const customerSectionStart = agentText.search(/\bCustomer\s+Details\b/i);
    // Find Important Links section start
    const importantLinksStart  = agentText.search(/\bImportant\s+Links\b/i);
    // Customer block = between Customer Details and Important Links (or end)
    const customerEnd = importantLinksStart > customerSectionStart
      ? importantLinksStart : agentText.length;
    const customerZone = customerSectionStart >= 0
      ? agentText.slice(customerSectionStart, customerEnd)
      : '';

    // ══════════════════════════════════════════════════════════════════════
    // PRODUCT DETAILS
    // Dense comma-separated: Booking_Id:28228130, Tour_Name:..., Tour_Group_Id:16959, City:Budapest, Tour_Id:40312
    // ══════════════════════════════════════════════════════════════════════

    const productDetails = {
      bookingId:   extractInline(agentText, 'Booking_Id'),
      tourName:    extractInline(agentText, 'Tour_Name'),
      tourGroupId: extractInline(agentText, 'Tour_Group_Id'),
      city:        extractInline(agentText, 'City'),
      tourId:      extractInline(agentText, 'Tour_Id')
    };

    // ══════════════════════════════════════════════════════════════════════
    // BOOKING DETAILS
    // ══════════════════════════════════════════════════════════════════════

    const bookingDetails = {
      date:           extractInline(agentText, 'Date'),
      startTime:      extractInline(agentText, 'Start_Time'),
      guestNumbers:   extractInline(agentText, 'Guest_Numbers'),
      finalPricePaid: extractInline(agentText, 'Final Price Paid'),
      netPrice:       extractInline(agentText, 'Net Price'),
      promoDiscount:  extractInline(agentText, 'Promo Discount')
    };

    // ══════════════════════════════════════════════════════════════════════
    // GUEST EXTRACTION
    //
    // Returns every Label: Value pair found in each guest block, dynamically.
    // No preset field list — nothing is omitted.
    // ══════════════════════════════════════════════════════════════════════

    /**
     * Parse every Label: Value pair from a text block.
     * Handles both comma-separated dense lines and one-per-line formats.
     * Underscores in label names are replaced with spaces for readability.
     */
    const parseGuestLines = (block) => {
      const result = [];
      const lines = block.split('\n').map(l => l.trim()).filter(Boolean);
      for (const line of lines) {
        // Split on comma boundaries followed by a new Label: pattern
        const parts = line.split(/,\s*(?=[A-Za-z][A-Za-z0-9_ ]*\s*:)/);
        for (const part of parts) {
          const m = part.match(/^([A-Za-z][A-Za-z0-9_ ]*?)\s*:\s*(.+)$/);
          if (m) {
            const label = m[1].trim().replace(/_/g, ' ').replace(/\s+/g, ' ');
            const value = m[2].trim();
            if (value && value !== 'N/A' && value !== 'null' && value !== 'undefined') {
              result.push({ label, value });
            }
          }
        }
      }
      return result;
    };

    const extractGuests = () => {
      const zone = customerZone || agentText;
      const headerRx = /\b([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*_Number_\d+)\b/g;
      const headers  = Array.from(zone.matchAll(headerRx));

      if (!headers.length) {
        // No guest-type headers — treat entire customer zone as one block
        const lines = parseGuestLines(zone);
        return lines.length ? [{ guestType: null, lines }] : [];
      }

      return headers.map((header, idx) => {
        const blockStart = header.index + header[0].length;
        const blockEnd   = idx + 1 < headers.length ? headers[idx + 1].index : zone.length;
        const block      = zone.slice(blockStart, blockEnd);
        return { guestType: header[1], lines: parseGuestLines(block) };
      });
    };

    // ══════════════════════════════════════════════════════════════════════
    // IMPORTANT LINKS — only BMS and Aries
    //
    // From screenshot 2: these are rendered in Zendesk html_body as:
    //   BMS Link: <a href="https://aries.headout.com/bms/booking/28228130">https://aries...</a>
    //   Aries Inventory Link: <a href="https://aries.headout.com/inventory?...">https://aries...</a>
    //
    // extractLink() uses the raw HTML (agentHtml) to find the href attribute.
    // ══════════════════════════════════════════════════════════════════════

    const links = {
      bmsLink:            extractLink(agentHtml, 'BMS Link'),
      ariesInventoryLink: extractLink(agentHtml, 'Aries Inventory Link'),
      productLink:        extractLink(agentHtml, 'Product Link'),
      vendorLink:         extractLink(agentHtml, 'Vendor Link')
    };

    // ══════════════════════════════════════════════════════════════════════
    // POST BOOKING INFORMATION
    // ══════════════════════════════════════════════════════════════════════

    const postBookingInfo = {
      isCancellable:        extractInline(agentText, 'Is Cancellable'),
      cancellableUpto:      extractInline(agentText, 'Cancellable upto'),
      isReschedulable:      extractInline(agentText, 'Is Reschedulable'),
      reschedulableUpto:    extractInline(agentText, 'Reschedulable upto'),
      meetingPoint:         extractInline(agentText, 'Meeting point address'),
      googleMapsUrl:        extractLink(agentHtml, 'Google Maps'),
      ticketValidity:       extractInline(agentText, 'Ticket Validity'),
      isInventoryAutomated: extractInline(agentText, 'Is inventory Automated')
    };

    // ══════════════════════════════════════════════════════════════════════
    // INSTRUCTIONS
    //
    // These appear in the agentText BEFORE the Vendor & Tour Info divider.
    // They can appear in many different formats depending on the booking type:
    //
    // FORMAT A — Heading with trailing quote, content ends with standalone quote:
    //   Important Instruction "
    //   - Manual Booking
    //   Step 1: Go to the portal.
    //   Step 2: ...
    //   "
    //
    // FORMAT B — Heading followed by colon and content on same/next line:
    //   Important Instruction: Go to the portal and select the date...
    //
    // FORMAT C — Bold HTML heading then content:
    //   <strong>Important Instruction</strong>
    //   Step 1: ...
    //
    // FORMAT D — Booking Instruction is a label:value where value is a quoted block:
    //   Booking Instruction
    //   Booking Instruction:"For Cancelation: These tickets are NON-CANCELABLE..."
    //
    // FORMAT E — Just a paragraph of text with no step markers:
    //   Important Instruction "
    //   This is an automated booking. No manual action needed.
    //   "
    //
    // FORMAT F — For Cancelation prefix (seen in screenshot 5):
    //   For Cancelation: These tickets are NON-CANCELABLE.
    //
    // APPROACH:
    //  1. Find the heading (case-insensitive, singular/plural, bold/plain)
    //  2. Capture everything from after the heading to the next section boundary
    //  3. Parse captured text into summary + steps flexibly
    // ══════════════════════════════════════════════════════════════════════

    const extractInstructions = () => {
      const important = { summary: '', steps: [], richHtml: null };
      const booking   = { summary: '', steps: [], richHtml: null };

      // ── Boundary patterns (these run against raw HTML) ────────────────────────
      // Vendor divider in HTML: dashes and "Vendor" text, possibly in a tag
      const vendorBoundary      = '[-]{3,}[^<\\n]*Vendor|--\\s*Vendor|Vendor\\s*(?:&amp;|&)\\s*Tour';
      // Booking Instruction heading in HTML
      const bookingInstrBoundary = 'Booking\\s+Instructi(?:on|ons)';

      // ── HELPERS ────────────────────────────────────────────────────────────

      /**
       * Detect whether a raw HTML block contains any HTML tags.
       * We treat ANY markup as rich HTML so we always preserve Zendesk's
       * original formatting rather than falling back to stripped text.
       */
      const isRichHtml = (html) => html && /<[a-z][^>]*>/i.test(html);

      /**
       * Sanitise rich HTML for safe display inside the sidebar.
       * Removes dangerous elements (scripts, iframes, forms) and event handlers.
       * KEEPS visual structure: divs, spans with styles, tables, lists, headings.
       * This preserves Zendesk's formatting and layout.
       * Removes only "Proceed to Booking" button-style elements.
       */
      const sanitiseHtml = (html) => {
        // Strip leading quote that Zendesk sometimes adds
        let safe = html.replace(/^["']/, '');
        
        safe = safe
          // Remove dangerous elements entirely
          .replace(/<script[\s\S]*?<\/script>/gi, '')
          .replace(/<iframe[\s\S]*?<\/iframe>/gi, '')
          .replace(/<form[\s\S]*?<\/form>/gi, '')
          .replace(/<input[^>]*>/gi, '')
          .replace(/<link[^>]*>/gi, '')
          // Remove only internal style content but KEEP the <style> tags and their content
          // This allows CSS styling to be preserved while removing dangerous content
          .replace(/<style[\s\S]*?<\/style>/gi, (match) => {
            // Keep the style tag but sanitize its content
            return match
              .replace(/javascript:/gi, '')
              .replace(/expression\s*\(/gi, '')
              .replace(/@import/gi, '');
          })
          // Remove event handlers (but keep the tags and styles)
          .replace(/\s+on\w+="[^"]*"/gi, '')
          .replace(/\s+on\w+='[^']*'/gi, '')
          // Fix javascript: hrefs
          .replace(/href="javascript:[^"]*"/gi, 'href="#"')
          // Ensure links are safe
          .replace(/<a\s+([^>]*?)>/gi, '<a target="_blank" rel="noopener noreferrer" $1>')
          // Remove duplicate target attrs
          .replace(/(target="_blank"\s*){2,}/gi, 'target="_blank" ')
          // Remove images (won't load in sidebar)
          .replace(/<img[^>]*>/gi, '')
          // Remove only Proceed/Book buttons, not other divs
          .replace(/<a\s+[^>]*class="[^"]*button[^"]*"[^>]*>\s*(?:Proceed|Book|Continue|Submit)[^<]*<\/a>/gi, '');

        // Preserve <br> tags for line breaks
        safe = safe.replace(/<br\s*\/?>/gi, '<br/>');
        
        return safe;
      };

      /**
       * Parse a plain-text instruction block into { summary, steps }.
       * Handles: numbered steps, bullet points, notes, continuation lines.
       */
      const parseBlock = (rawText) => {
        const text = rawText
          .replace(/^\s*["']\s*\n?/m, '')  // strip opening quote line
          .replace(/\n?\s*["']\s*$/m, '')  // strip closing quote line
          .trim();

        if (!text) return { summary: '', steps: [] };

        const lines = text.split('\n').map(l => l.trim()).filter(l => l && !/^["']+$/.test(l));
        if (!lines.length) return { summary: '', steps: [] };

        const steps = [];
        let summary = '';
        let cur = null;

        const flush = () => { if (cur) { steps.push(cur); cur = null; } };

        for (const line of lines) {
          const stepM   = line.match(/^(?:Step\s+)?(\d+)\s*[.):\-]\s*(.+)/i);
          const bulletM = line.match(/^[-•·→*≡]\s*(.+)/);
          const noteM   = line.match(/^Note\s*:\s*(.+)/i);

          if (stepM) {
            flush();
            cur = { num: parseInt(stepM[1], 10), text: stepM[2].trim(), subs: [] };
          } else if (bulletM && cur) {
            cur.subs.push(bulletM[1].trim());
          } else if (bulletM) {
            flush();
            cur = { num: steps.length + 1, text: bulletM[1].trim(), subs: [] };
          } else if (noteM) {
            flush();
            steps.push({ num: null, text: `Note: ${noteM[1].trim()}`, subs: [] });
          } else if (!steps.length && !cur) {
            summary = summary ? summary + ' ' + line : line;
          } else if (cur) {
            cur.text += ' ' + line;
          } else {
            steps.push({ num: null, text: line, subs: [] });
          }
        }
        flush();

        return {
          summary: summary.trim(),
          steps: steps
            .map(s => {
              const prefix = s.num !== null ? `Step ${s.num}: ` : '';
              const subs   = s.subs.length ? '\n' + s.subs.map(b => `  • ${b}`).join('\n') : '';
              return prefix + s.text + subs;
            })
            .filter(s => {
              const cleaned = s.replace(/Step \d+: /i, '').trim();
              return cleaned.length > 2 && !/^[-=_*~\s]+$/.test(cleaned);
            })
        };
      };

      /**
       * Find an instruction section and return both its raw HTML and plain text.
       *
       * Strategy A — HTML heading tag:
       *   Zendesk sometimes bolds the label: <strong>Important Instruction</strong>
       *   We capture everything after the closing tag until the end boundary.
       *
       * Strategy B — Plain text label in raw HTML:
       *   The label "Important Instruction" appears as visible text (possibly
       *   followed by a " character) and the styled card follows as raw HTML.
       *   We find the label's position in the raw HTML stream and capture from
       *   there to the end boundary.
       *
       *   This handles the new screenshot case where the label is plain text and
       *   the entire booking card (div with border, coloured heading, list, button)
       *   follows immediately as rich HTML.
       *
       * endHtmlPattern: a regex SOURCE string that matches end-of-section in HTML.
       */
      const findSectionHtml = (headingPattern, endHtmlPattern) => {
        // ── Strategy A: heading inside a tag ──────────────────────────────────
        const taggedRx = new RegExp(
          `<(?:strong|b|h[1-6]|span|p)[^>]*>[^<]*${headingPattern}[^<]*<\\/(?:strong|b|h[1-6]|span|p)>` +
          `([\\s\\S]*?)(?=${endHtmlPattern}|$)`,
          'i'
        );
        const taggedM = taggedRx.exec(agentHtml);
        if (taggedM) {
          let rawHtml = taggedM[1];
          // Strip leading quote that Zendesk sometimes adds
          rawHtml = rawHtml.replace(/^["']/, '');
          return { rawHtml, rawText: stripHtml(rawHtml) };
        }

        // ── Strategy B: label as visible plain text in the HTML stream ─────────
        const plainInHtmlRx = new RegExp(
          `${headingPattern}\\s*["']?\\s*(?:<[^>]+>\\s*)*([\\s\\S]*?)(?=${endHtmlPattern}|$)`,
          'i'
        );
        const plainInHtmlM = plainInHtmlRx.exec(agentHtml);
        if (plainInHtmlM) {
          let rawHtml = plainInHtmlM[1];
          // Strip leading quote that Zendesk sometimes adds
          rawHtml = rawHtml.replace(/^["']/, '');
          return { rawHtml, rawText: stripHtml(rawHtml) };
        }

        return null;
      };

      // ── Extract Important Instruction ──────────────────────────────────────
      // Only stop at the vendor divider — NOT at bookingInstrBoundary.
      // Zendesk cards often contain "Booking Instructions" as a heading *inside*
      // the Important Instruction card itself. Using bookingInstrBoundary as a
      // stop signal was truncating the captured HTML at ~378 chars mid-card.
      const importantEndPat = vendorBoundary;
      const importantResult = findSectionHtml('Important\\s+Instructi(?:on|ons)', importantEndPat);

      if (importantResult) {
        const { rawHtml, rawText } = importantResult;
        // Always store whatever Zendesk sent — HTML or plain text — so the UI
        // shows the full content exactly as written, no parsing loss.
        if (rawHtml && rawHtml.trim()) {
          important.richHtml = sanitiseHtml(rawHtml);
        } else if (rawText && rawText.trim()) {
          important.richHtml = rawText; // plain text; renderRichHtml handles it
        }
      } else {
        // Fallback: first <hr>-anchored styled card in the HTML
        const cardStartRx = /(<hr\s*\/?>[\s\S]*?<(?:h[1-6]|div|ul|ol)[^>]*>[\s\S]+)/i;
        const cardMatch = cardStartRx.exec(agentHtml);
        if (cardMatch) important.richHtml = sanitiseHtml(cardMatch[1]);
      }

      // ── Extract Booking Instruction ────────────────────────────────────────
      // Always try HTML extraction first (preserves formatting). Only fall back
      // to plain-text label:value if no HTML section is found.
      const bookingResult = findSectionHtml('Booking\\s+Instructi(?:on|ons)', vendorBoundary);
      if (bookingResult) {
        const { rawHtml, rawText } = bookingResult;
        if (rawHtml && rawHtml.trim()) {
          booking.richHtml = sanitiseHtml(rawHtml);
        } else if (rawText && rawText.trim()) {
          // Strip repeated heading prefix and store as plain text
          booking.richHtml = rawText.replace(/^\s*Booking\s+Instructi(?:on|ons)\s*:\s*["']?/i, '').trim();
        }
      } else {
        // Plain-text fallback: "Booking Instruction: content"
        const bookingLabelValueRx = new RegExp(
          `Booking\\s+Instructi(?:on|ons)\\s*:\\s*["']?([\\s\\S]*?)["']?\\s*(?=${vendorBoundary}|$)`,
          'i'
        );
        const lvM = bookingLabelValueRx.exec(agentText);
        if (lvM && lvM[1].trim()) booking.richHtml = lvM[1].trim();
      }

      return { importantInstructions: important, bookingInstructions: booking };
    };

    // ══════════════════════════════════════════════════════════════════════
    // CUSTOMER RAW HTML
    // Extract the HTML block from "Customer Details" to the next section
    // so it can be rendered verbatim — no field-parsing, no data loss.
    // ══════════════════════════════════════════════════════════════════════

    const extractCustomerHtml = () => {
      const rx = /Customer\s+Details[\s\S]*?(?=\bImportant\s+Links\b|\bPost\s+Booking\b|Important\s+Instruct|Booking\s+Instruct|[-]{3,}|$)/i;
      const m = rx.exec(agentHtml);
      if (!m || !m[0].replace(/<[^>]*>/g, '').trim()) return null;
      return m[0]
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<iframe[\s\S]*?<\/iframe>/gi, '')
        .replace(/\s+on\w+="[^"]*"/gi, '')
        .replace(/href="javascript:[^"]*"/gi, 'href="#"')
        .replace(/<a\s+([^>]*?)>/gi, '<a target="_blank" rel="noopener noreferrer" $1>');
    };

    // ══════════════════════════════════════════════════════════════════════
    // ASSEMBLE
    // ══════════════════════════════════════════════════════════════════════

    return {
      ticketDetails: {
        productDetails,
        bookingDetails,
        customerDetails: { guests: extractGuests(), rawHtml: extractCustomerHtml() },
        postBookingInfo,
        links
      },
      instructions: extractInstructions()
    };

  } catch (err) {
    console.error('parseTicketHtml error:', err);
    return DEFAULT;
  }
}
