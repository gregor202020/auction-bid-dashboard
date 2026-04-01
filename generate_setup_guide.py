"""Generate the SETUP-GUIDE.pdf for the Live Auction Bid Dashboard."""

from reportlab.lib.pagesizes import A4
from reportlab.lib.units import mm, cm
from reportlab.lib.colors import HexColor, white, black
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.enums import TA_LEFT, TA_CENTER
from reportlab.platypus import (
    SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle,
    PageBreak, KeepTogether, HRFlowable
)
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
import os

# Colors
PRIMARY = HexColor("#1a73e8")
DARK = HexColor("#1a1a2e")
ACCENT = HexColor("#00c853")
LIGHT_BG = HexColor("#f5f7fa")
CODE_BG = HexColor("#1e1e2e")
CODE_TEXT = HexColor("#cdd6f4")
BORDER = HexColor("#dde1e6")
SECTION_NUM = HexColor("#e8eaf6")
MUTED = HexColor("#5f6368")
WARN_BG = HexColor("#fff8e1")
WARN_BORDER = HexColor("#f9a825")

OUTPUT = os.path.join(os.path.dirname(__file__), "SETUP-GUIDE.pdf")

doc = SimpleDocTemplate(
    OUTPUT,
    pagesize=A4,
    topMargin=2*cm,
    bottomMargin=2*cm,
    leftMargin=2.2*cm,
    rightMargin=2.2*cm,
    title="Live Auction Bid Dashboard — Setup Guide",
    author="Third Wave BBQ",
)

styles = getSampleStyleSheet()

# Custom styles
styles.add(ParagraphStyle(
    "DocTitle", parent=styles["Title"],
    fontSize=26, leading=32, textColor=DARK,
    spaceAfter=4*mm, alignment=TA_CENTER,
    fontName="Helvetica-Bold",
))
styles.add(ParagraphStyle(
    "DocSubtitle", parent=styles["Normal"],
    fontSize=13, leading=18, textColor=MUTED,
    spaceAfter=12*mm, alignment=TA_CENTER,
))
styles.add(ParagraphStyle(
    "SectionTitle", parent=styles["Heading1"],
    fontSize=16, leading=22, textColor=PRIMARY,
    spaceBefore=10*mm, spaceAfter=4*mm,
    fontName="Helvetica-Bold",
    borderWidth=0,
))
styles.add(ParagraphStyle(
    "SubSection", parent=styles["Heading2"],
    fontSize=12, leading=16, textColor=DARK,
    spaceBefore=5*mm, spaceAfter=3*mm,
    fontName="Helvetica-Bold",
))
styles.add(ParagraphStyle(
    "Body", parent=styles["Normal"],
    fontSize=10, leading=15, textColor=HexColor("#333333"),
    spaceAfter=3*mm,
))
styles.add(ParagraphStyle(
    "BulletItem", parent=styles["Normal"],
    fontSize=10, leading=15, textColor=HexColor("#333333"),
    leftIndent=12*mm, bulletIndent=5*mm,
    spaceAfter=1.5*mm,
))
styles.add(ParagraphStyle(
    "NumberedItem", parent=styles["Normal"],
    fontSize=10, leading=15, textColor=HexColor("#333333"),
    leftIndent=12*mm, bulletIndent=5*mm,
    spaceAfter=1.5*mm,
))
styles.add(ParagraphStyle(
    "CodeBlock", parent=styles["Normal"],
    fontSize=9, leading=13, textColor=HexColor("#1e1e2e"),
    fontName="Courier",
    leftIndent=5*mm, rightIndent=5*mm,
    spaceBefore=2*mm, spaceAfter=2*mm,
    backColor=HexColor("#f0f2f5"),
    borderWidth=0.5, borderColor=BORDER,
    borderPadding=6,
))
styles.add(ParagraphStyle(
    "CodeInline", parent=styles["Normal"],
    fontSize=9, fontName="Courier",
    textColor=HexColor("#d32f2f"),
))
styles.add(ParagraphStyle(
    "Footer", parent=styles["Normal"],
    fontSize=8, textColor=MUTED, alignment=TA_CENTER,
))
styles.add(ParagraphStyle(
    "TOCEntry", parent=styles["Normal"],
    fontSize=11, leading=20, textColor=DARK,
    leftIndent=8*mm,
))


def section_header(number, title):
    """Create a styled section header with number badge."""
    return Paragraph(
        f'<font color="{PRIMARY.hexval()}">{number}.</font>  {title}',
        styles["SectionTitle"]
    )


def bullet(text):
    return Paragraph(f"<bullet>&bull;</bullet> {text}", styles["BulletItem"])


def numbered(num, text):
    return Paragraph(f"<bullet>{num}.</bullet> {text}", styles["NumberedItem"])


def code_block(lines):
    """Render a code block as a table with background."""
    code_text = "<br/>".join(lines)
    para = Paragraph(code_text, styles["CodeBlock"])
    t = Table([[para]], colWidths=[doc.width - 10*mm])
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), HexColor("#f0f2f5")),
        ("BOX", (0, 0), (-1, -1), 0.5, BORDER),
        ("TOPPADDING", (0, 0), (-1, -1), 4*mm),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4*mm),
        ("LEFTPADDING", (0, 0), (-1, -1), 4*mm),
        ("RIGHTPADDING", (0, 0), (-1, -1), 4*mm),
    ]))
    return t


def note_box(text, bg=WARN_BG, border=WARN_BORDER):
    """Render a note/tip box."""
    para = Paragraph(text, styles["Body"])
    t = Table([[para]], colWidths=[doc.width - 10*mm])
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), bg),
        ("BOX", (0, 0), (-1, -1), 1, border),
        ("TOPPADDING", (0, 0), (-1, -1), 3*mm),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 3*mm),
        ("LEFTPADDING", (0, 0), (-1, -1), 4*mm),
        ("RIGHTPADDING", (0, 0), (-1, -1), 4*mm),
    ]))
    return t


def hr():
    return HRFlowable(width="100%", thickness=0.5, color=BORDER, spaceAfter=4*mm, spaceBefore=4*mm)


# ─── Build Story ────────────────────────────────────────────────────

story = []

# ─── Title Page ─────────────────────────────────────────────────────
story.append(Spacer(1, 40*mm))
story.append(Paragraph("Live Auction Bid Dashboard", styles["DocTitle"]))
story.append(Paragraph("Setup Guide", ParagraphStyle(
    "SetupSub", parent=styles["DocTitle"], fontSize=20, textColor=MUTED,
    spaceAfter=8*mm,
)))
story.append(hr())
story.append(Paragraph(
    "Aggregate live bids from YouTube, Facebook, Instagram &amp; TikTok<br/>"
    "into a single real-time auction dashboard.",
    styles["DocSubtitle"]
))
story.append(Spacer(1, 20*mm))

# Platform badges
platforms = [
    ("YouTube", "#FF0000"),
    ("Facebook", "#1877F2"),
    ("Instagram", "#E4405F"),
    ("TikTok", "#000000"),
]
badge_data = [[
    Paragraph(
        f'<font color="white" size="10"><b>  {name}  </b></font>',
        styles["Body"]
    ) for name, _ in platforms
]]
badge_table = Table(badge_data, colWidths=[doc.width / 4] * 4)
badge_table.setStyle(TableStyle([
    ("BACKGROUND", (i, 0), (i, 0), HexColor(c)) for i, (_, c) in enumerate(platforms)
] + [
    ("ALIGN", (0, 0), (-1, -1), "CENTER"),
    ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
    ("TOPPADDING", (0, 0), (-1, -1), 3*mm),
    ("BOTTOMPADDING", (0, 0), (-1, -1), 3*mm),
    ("LEFTPADDING", (0, 0), (-1, -1), 2*mm),
    ("RIGHTPADDING", (0, 0), (-1, -1), 2*mm),
    ("ROUNDEDCORNERS", [3, 3, 3, 3]),
]))
story.append(badge_table)

story.append(Spacer(1, 30*mm))
story.append(Paragraph("Version 1.0  |  March 2026", ParagraphStyle(
    "VersionLine", parent=styles["Body"], alignment=TA_CENTER, textColor=MUTED, fontSize=9,
)))
story.append(PageBreak())

# ─── Table of Contents ──────────────────────────────────────────────
story.append(Paragraph("Contents", styles["SectionTitle"]))
story.append(Spacer(1, 4*mm))
toc_items = [
    "Overview",
    "Prerequisites",
    "Local Installation",
    "Running the Dashboard",
    "During a Live Auction",
    "Bid Format Recognition",
    "Spam Filter Settings",
    "VPS Deployment",
    "Demo Mode",
    "GitHub Repository",
]
for i, item in enumerate(toc_items, 1):
    story.append(Paragraph(
        f'<font color="{PRIMARY.hexval()}"><b>{i}.</b></font>  {item}',
        styles["TOCEntry"]
    ))
story.append(PageBreak())

# ─── Section 1: Overview ────────────────────────────────────────────
story.append(section_header(1, "Overview"))
story.append(Paragraph(
    "The Live Auction Bid Dashboard aggregates live bids from <b>YouTube</b>, "
    "<b>Facebook</b>, <b>Instagram</b>, and <b>TikTok</b> live streams into a "
    "single, unified interface. It is purpose-built for live charity auctions, "
    "fundraisers, and social-media-driven sales events.",
    styles["Body"]
))
story.append(Spacer(1, 2*mm))
story.append(Paragraph("<b>Key Features</b>", styles["SubSection"]))
story.append(bullet("Real-time bid aggregation across four platforms"))
story.append(bullet("Highest-bid display, live leaderboard, and platform breakdown"))
story.append(bullet("Intelligent bid parsing: <font name='Courier' size='9'>$500</font>, "
                     "<font name='Courier' size='9'>BID 500</font>, "
                     "<font name='Courier' size='9'>\"I bid 500\"</font>, and more"))
story.append(bullet("Built-in spam filter with configurable thresholds"))
story.append(bullet("Per-user blocking to remove bad actors"))
story.append(bullet("Demo mode for testing before going live"))
story.append(bullet("Multi-auction support — clear bids between items without disconnecting"))

# ─── Section 2: Prerequisites ───────────────────────────────────────
story.append(section_header(2, "Prerequisites"))
story.append(bullet("<b>Node.js 18+</b> — download from <font color='#1a73e8'>https://nodejs.org</font>"))
story.append(bullet("API credentials configured in a <font name='Courier' size='9'>.env</font> file (see Section 3)"))
story.append(Spacer(1, 3*mm))
story.append(Paragraph("<b>Required API Keys</b>", styles["SubSection"]))

api_data = [
    [
        Paragraph("<b>Platform</b>", styles["Body"]),
        Paragraph("<b>Credential</b>", styles["Body"]),
        Paragraph("<b>Source</b>", styles["Body"]),
    ],
    [
        Paragraph("YouTube", styles["Body"]),
        Paragraph("Data API v3 Key", styles["Body"]),
        Paragraph("Google Cloud Console", styles["Body"]),
    ],
    [
        Paragraph("Facebook", styles["Body"]),
        Paragraph("Meta Access Token", styles["Body"]),
        Paragraph("Meta Developer Portal", styles["Body"]),
    ],
    [
        Paragraph("Instagram", styles["Body"]),
        Paragraph("(same Meta token)", styles["Body"]),
        Paragraph("Covered by Facebook token", styles["Body"]),
    ],
    [
        Paragraph("TikTok", styles["Body"]),
        Paragraph("None required", styles["Body"]),
        Paragraph("Uses community library", styles["Body"]),
    ],
]
api_table = Table(api_data, colWidths=[35*mm, 45*mm, 65*mm])
api_table.setStyle(TableStyle([
    ("BACKGROUND", (0, 0), (-1, 0), PRIMARY),
    ("TEXTCOLOR", (0, 0), (-1, 0), white),
    ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
    ("BACKGROUND", (0, 1), (-1, -1), HexColor("#fafbfc")),
    ("GRID", (0, 0), (-1, -1), 0.5, BORDER),
    ("TOPPADDING", (0, 0), (-1, -1), 2*mm),
    ("BOTTOMPADDING", (0, 0), (-1, -1), 2*mm),
    ("LEFTPADDING", (0, 0), (-1, -1), 3*mm),
    ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
]))
story.append(api_table)

# ─── Section 3: Local Installation ──────────────────────────────────
story.append(section_header(3, "Local Installation"))
story.append(Paragraph("Navigate to the dashboard directory and install dependencies:", styles["Body"]))
story.append(code_block([
    '$ cd "Social Media Analyser/auction-bid-dashboard"',
    "$ npm install",
]))
story.append(Spacer(1, 3*mm))
story.append(Paragraph(
    "Create a <font name='Courier' size='9'>.env</font> file in the "
    "<font name='Courier' size='9'>auction-bid-dashboard</font> directory "
    "(or the parent <font name='Courier' size='9'>Social Media Analyser</font> directory):",
    styles["Body"]
))
story.append(code_block([
    "META_ACCESS_TOKEN=your_meta_token_here",
    "AUCTION_YOUTUBE_API_KEY=your_dedicated_auction_youtube_api_key_here",
    "# Optional fallback: YOUTUBE_API_KEY=your_shared_youtube_api_key_here",
    "TIKTOK_ACCESS_TOKEN=optional",
    "AUCTION_PORT=3069",
]))
story.append(note_box(
    "<b>Note:</b> The TikTok token is optional. TikTok integration uses a community "
    "library that does not require authentication for reading live comments."
))

# ─── Section 4: Running the Dashboard ───────────────────────────────
story.append(section_header(4, "Running the Dashboard"))
story.append(code_block([
    "# Production",
    "$ npm start",
    "# or",
    "$ node server.js",
    "",
    "# Development (auto-reload)",
    "$ npm run dev",
]))
story.append(Paragraph(
    "Once running, open your browser to:",
    styles["Body"]
))
story.append(code_block([
    "http://localhost:3069",
]))

# ─── Section 5: During a Live Auction ───────────────────────────────
story.append(section_header(5, "During a Live Auction"))
story.append(numbered(1, 'Open <font color="#1a73e8">http://localhost:3069</font> in your browser'))
story.append(numbered(2, 'Click <b>"Settings"</b> to expand the connection panel'))
story.append(numbered(3, "Enter platform identifiers:"))
story.append(Spacer(1, 1*mm))

platform_ids = [
    ["YouTube", 'Video ID — the part after <font name="Courier" size="9">v=</font> in the URL'
     '<br/>(e.g., <font name="Courier" size="9">dQw4w9WgXcQ</font>)'],
    ["Facebook", "Live Video ID from your Facebook Live"],
    ["Instagram", "Live Media ID"],
    ["TikTok", 'Username without <font name="Courier" size="9">@</font>'],
]
pid_table = Table(
    [[Paragraph(f"<b>{p}</b>", styles["Body"]),
      Paragraph(d, styles["Body"])] for p, d in platform_ids],
    colWidths=[30*mm, doc.width - 45*mm],
)
pid_table.setStyle(TableStyle([
    ("GRID", (0, 0), (-1, -1), 0.4, BORDER),
    ("BACKGROUND", (0, 0), (0, -1), HexColor("#f0f4ff")),
    ("TOPPADDING", (0, 0), (-1, -1), 2*mm),
    ("BOTTOMPADDING", (0, 0), (-1, -1), 2*mm),
    ("LEFTPADDING", (0, 0), (-1, -1), 3*mm),
    ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
]))
story.append(pid_table)
story.append(Spacer(1, 3*mm))

story.append(numbered(4, 'Click <b>"Connect"</b> for each platform — a green dot means connected'))
story.append(numbered(5, "Bids flow in automatically from live comments"))
story.append(numbered(6, 'Use <b>"Disregard"</b> to remove invalid bids'))
story.append(numbered(7, 'Use <b>"Block"</b> to block spam users'))
story.append(numbered(8, 'Click <b>"New Auction"</b> between items (clears bids, keeps connections)'))

# ─── Section 6: Bid Format Recognition ──────────────────────────────
story.append(section_header(6, "Bid Format Recognition"))
story.append(Paragraph("The bid parser recognises the following comment formats:", styles["Body"]))
story.append(Spacer(1, 2*mm))

bid_data = [
    [Paragraph("<b>Format</b>", styles["Body"]), Paragraph("<b>Examples</b>", styles["Body"])],
    [Paragraph("Dollar sign", styles["Body"]),
     Paragraph('<font name="Courier" size="9">$500</font>, '
               '<font name="Courier" size="9">$1,500.00</font>', styles["Body"])],
    [Paragraph("BID keyword", styles["Body"]),
     Paragraph('<font name="Courier" size="9">BID 500</font>, '
               '<font name="Courier" size="9">bid $500</font>', styles["Body"])],
    [Paragraph("Natural language", styles["Body"]),
     Paragraph('<font name="Courier" size="9">I bid 500</font>, '
               '<font name="Courier" size="9">bidding 1500</font>', styles["Body"])],
    [Paragraph("Currency words", styles["Body"]),
     Paragraph('<font name="Courier" size="9">500 dollars</font>, '
               '<font name="Courier" size="9">500 bucks</font>, '
               '<font name="Courier" size="9">500 AUD</font>', styles["Body"])],
    [Paragraph("AUD prefix", styles["Body"]),
     Paragraph('<font name="Courier" size="9">AUD 500</font>, '
               '<font name="Courier" size="9">A$500</font>', styles["Body"])],
    [Paragraph("Plain numbers", styles["Body"]),
     Paragraph('<font name="Courier" size="9">500</font> (medium confidence)', styles["Body"])],
    [Paragraph("Informal", styles["Body"]),
     Paragraph('<font name="Courier" size="9">going 500</font> (low confidence)', styles["Body"])],
]
bid_table = Table(bid_data, colWidths=[40*mm, doc.width - 55*mm])
bid_table.setStyle(TableStyle([
    ("BACKGROUND", (0, 0), (-1, 0), PRIMARY),
    ("TEXTCOLOR", (0, 0), (-1, 0), white),
    ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
    ("BACKGROUND", (0, 1), (-1, -1), HexColor("#fafbfc")),
    ("GRID", (0, 0), (-1, -1), 0.5, BORDER),
    ("TOPPADDING", (0, 0), (-1, -1), 2*mm),
    ("BOTTOMPADDING", (0, 0), (-1, -1), 2*mm),
    ("LEFTPADDING", (0, 0), (-1, -1), 3*mm),
    ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
]))
story.append(bid_table)
story.append(Spacer(1, 3*mm))
story.append(Paragraph("<b>Automatically rejected:</b> phone numbers, years (2020–2035), "
                        "timestamps, item/lot references.", styles["Body"]))

# ─── Section 7: Spam Filter Settings ────────────────────────────────
story.append(section_header(7, "Spam Filter Settings"))
story.append(Paragraph("Configure these thresholds in the Settings panel:", styles["Body"]))
story.append(Spacer(1, 2*mm))

spam_data = [
    [Paragraph("<b>Setting</b>", styles["Body"]),
     Paragraph("<b>Default</b>", styles["Body"]),
     Paragraph("<b>Description</b>", styles["Body"])],
    [Paragraph("Min Bid", styles["Body"]),
     Paragraph("$1", styles["Body"]),
     Paragraph("Reject bids below this amount", styles["Body"])],
    [Paragraph("Max Bid", styles["Body"]),
     Paragraph("$50,000", styles["Body"]),
     Paragraph("Reject bids above this amount", styles["Body"])],
    [Paragraph("Jump Cap", styles["Body"]),
     Paragraph("10x", styles["Body"]),
     Paragraph("Flag bids more than Nx the current highest", styles["Body"])],
    [Paragraph("Duplicate Window", styles["Body"]),
     Paragraph("30 sec", styles["Body"]),
     Paragraph("Same user, same amount within this window", styles["Body"])],
    [Paragraph("User Blocking", styles["Body"]),
     Paragraph("—", styles["Body"]),
     Paragraph("Block specific users per-platform", styles["Body"])],
]
spam_table = Table(spam_data, colWidths=[35*mm, 22*mm, doc.width - 72*mm])
spam_table.setStyle(TableStyle([
    ("BACKGROUND", (0, 0), (-1, 0), PRIMARY),
    ("TEXTCOLOR", (0, 0), (-1, 0), white),
    ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
    ("BACKGROUND", (0, 1), (-1, -1), HexColor("#fafbfc")),
    ("GRID", (0, 0), (-1, -1), 0.5, BORDER),
    ("TOPPADDING", (0, 0), (-1, -1), 2*mm),
    ("BOTTOMPADDING", (0, 0), (-1, -1), 2*mm),
    ("LEFTPADDING", (0, 0), (-1, -1), 3*mm),
    ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
]))
story.append(spam_table)

# ─── Section 8: VPS Deployment ──────────────────────────────────────
story.append(section_header(8, "VPS Deployment"))
story.append(Paragraph(
    "The dashboard is also deployed on a VPS for remote access:",
    styles["Body"]
))
story.append(code_block([
    "http://164.92.66.128:3069",
]))
story.append(Paragraph("It runs as a <b>systemd</b> service:", styles["Body"]))
story.append(code_block([
    "# Start / stop / restart",
    "$ systemctl start auction-dashboard",
    "$ systemctl stop auction-dashboard",
    "$ systemctl restart auction-dashboard",
    "",
    "# View logs",
    "$ journalctl -u auction-dashboard -f",
]))

# ─── Section 9: Demo Mode ──────────────────────────────────────────
story.append(section_header(9, "Demo Mode"))
story.append(Paragraph(
    "Use demo mode to test the dashboard before a real auction:",
    styles["Body"]
))
story.append(numbered(1, 'Open the dashboard and click <b>"Settings"</b>'))
story.append(numbered(2, 'Click <b>"Start Demo"</b>'))
story.append(numbered(3, "Realistic bids from simulated users will appear across all four platforms"))
story.append(numbered(4, "Use this to train operators and verify everything works before going live"))
story.append(note_box(
    "<b>Tip:</b> Demo mode is a great way to familiarise auction operators "
    "with the interface before a real event. Bids, leaderboard, and platform "
    "indicators all behave exactly as they would during a live stream."
))

# ─── Section 10: GitHub Repository ──────────────────────────────────
story.append(section_header(10, "GitHub Repository"))
story.append(Paragraph("Source code is available at:", styles["Body"]))
story.append(code_block([
    "https://github.com/gregor202020/twb-social-media-analyser",
]))
story.append(Spacer(1, 2*mm))

repo_data = [
    [Paragraph("<b>Branch</b>", styles["Body"]),
     Paragraph('<font name="Courier" size="9">master</font>', styles["Body"])],
    [Paragraph("<b>Subdirectory</b>", styles["Body"]),
     Paragraph('<font name="Courier" size="9">auction-bid-dashboard/</font>', styles["Body"])],
]
repo_table = Table(repo_data, colWidths=[35*mm, doc.width - 50*mm])
repo_table.setStyle(TableStyle([
    ("GRID", (0, 0), (-1, -1), 0.4, BORDER),
    ("BACKGROUND", (0, 0), (0, -1), HexColor("#f0f4ff")),
    ("TOPPADDING", (0, 0), (-1, -1), 2*mm),
    ("BOTTOMPADDING", (0, 0), (-1, -1), 2*mm),
    ("LEFTPADDING", (0, 0), (-1, -1), 3*mm),
    ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
]))
story.append(repo_table)

# ─── Footer ─────────────────────────────────────────────────────────
story.append(Spacer(1, 15*mm))
story.append(hr())
story.append(Paragraph(
    "Live Auction Bid Dashboard — Setup Guide  |  Version 1.0  |  March 2026",
    styles["Footer"]
))


# ─── Page number footer ─────────────────────────────────────────────
def add_page_number(canvas, doc):
    canvas.saveState()
    canvas.setFont("Helvetica", 8)
    canvas.setFillColor(MUTED)
    page_num = canvas.getPageNumber()
    canvas.drawCentredString(A4[0] / 2, 1.2 * cm, f"— {page_num} —")
    canvas.restoreState()


# Build
doc.build(story, onFirstPage=add_page_number, onLaterPages=add_page_number)
print(f"PDF generated: {OUTPUT}")
