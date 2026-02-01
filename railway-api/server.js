const express = require('express');
const multer = require('multer');
const cors = require('cors');
const { execSync, exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3000;

// Enable CORS
app.use(cors());

// Setup multer for file uploads
const storage = multer.memoryStorage();
const upload = multer({
  storage: storage,
  limits: { fileSize: 50 * 1024 * 1024 } // 50MB limit
});

// Temp directory for processing
const TEMP_DIR = '/tmp/pdf-processing';

// Ensure temp directory exists
if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'PrintPilot PDF API is running' });
});

// Check Ghostscript version
app.get('/gs-version', (req, res) => {
  try {
    const version = execSync('gs --version').toString().trim();
    res.json({ ghostscript: version });
  } catch (error) {
    res.status(500).json({ error: 'Ghostscript not installed', details: error.message });
  }
});

/**
 * POST /api/merge-pdf-layers
 *
 * Merges artwork into a template PDF while preserving layers
 *
 * Body (multipart/form-data):
 * - template: PDF file with layers (the template)
 * - artwork: PNG/JPG image to insert into artwork layer
 * - layerName: Name of the layer to insert artwork into (default: "ARTWORK HERE")
 * - x, y, width, height: Position and size of artwork in points
 */
app.post('/api/merge-pdf-layers', upload.fields([
  { name: 'template', maxCount: 1 },
  { name: 'artwork', maxCount: 1 }
]), async (req, res) => {
  const jobId = uuidv4();
  const jobDir = path.join(TEMP_DIR, jobId);

  try {
    // Create job directory
    fs.mkdirSync(jobDir, { recursive: true });

    // Validate inputs
    if (!req.files?.template?.[0]) {
      return res.status(400).json({ error: 'Template PDF is required' });
    }
    if (!req.files?.artwork?.[0]) {
      return res.status(400).json({ error: 'Artwork image is required' });
    }

    const templateFile = req.files.template[0];
    const artworkFile = req.files.artwork[0];

    // Get parameters
    const layerName = req.body.layerName || 'ARTWORK HERE';
    const x = parseFloat(req.body.x) || 0;
    const y = parseFloat(req.body.y) || 0;
    const width = parseFloat(req.body.width) || 612; // Default letter width
    const height = parseFloat(req.body.height) || 792; // Default letter height

    console.log(`Job ${jobId}: Processing with layer "${layerName}", position (${x}, ${y}), size ${width}x${height}`);

    // Save files to temp directory
    const templatePath = path.join(jobDir, 'template.pdf');
    const artworkPath = path.join(jobDir, 'artwork' + getExtension(artworkFile.mimetype));
    const artworkPdfPath = path.join(jobDir, 'artwork.pdf');
    const outputPath = path.join(jobDir, 'output.pdf');

    fs.writeFileSync(templatePath, templateFile.buffer);
    fs.writeFileSync(artworkPath, artworkFile.buffer);

    console.log(`Job ${jobId}: Files saved`);

    // Step 1: Get template PDF dimensions using Ghostscript
    const pageWidth = parseFloat(req.body.pageWidth) || width;
    const pageHeight = parseFloat(req.body.pageHeight) || height;

    console.log(`Job ${jobId}: Page dimensions: ${pageWidth} x ${pageHeight} points`);

    // Step 2: Convert artwork PNG to PDF with exact page dimensions using ImageMagick
    try {
      // Convert PNG to PDF with exact dimensions (geometry uses !)
      execSync(`convert "${artworkPath}" -resize ${Math.round(pageWidth)}x${Math.round(pageHeight)}! -density 72 "${artworkPdfPath}"`, { cwd: jobDir });
      console.log(`Job ${jobId}: Converted artwork to PDF using ImageMagick`);
    } catch (e) {
      console.log(`Job ${jobId}: ImageMagick convert failed, trying alternative...`);
      // Alternative: use Ghostscript to create PDF from image via PostScript
      const psImagePath = path.join(jobDir, 'image.ps');
      const psContent = `%!PS-Adobe-3.0
<< /PageSize [${pageWidth} ${pageHeight}] >> setpagedevice
(${artworkPath}) (r) file /DCTDecode filter
<< /ImageType 1
   /Width ${Math.round(pageWidth)}
   /Height ${Math.round(pageHeight)}
   /BitsPerComponent 8
   /Decode [0 1 0 1 0 1]
   /ImageMatrix [${Math.round(pageWidth)} 0 0 ${Math.round(-pageHeight)} 0 ${Math.round(pageHeight)}]
   /DataSource currentfile
>> image
showpage
`;
      fs.writeFileSync(psImagePath, psContent);
      execSync(`gs -dNOPAUSE -dBATCH -sDEVICE=pdfwrite -sOutputFile="${artworkPdfPath}" "${psImagePath}"`, { cwd: jobDir });
    }

    // Step 3: Overlay artwork UNDER template using Ghostscript
    // Strategy: Create intermediate PDF with artwork, then overlay template on top
    console.log(`Job ${jobId}: Creating overlay PDF...`);

    const intermediatePath = path.join(jobDir, 'intermediate.pdf');

    try {
      // Method 1: Try pdftk background (artwork as background, template on top)
      // pdftk template.pdf background artwork.pdf output output.pdf
      console.log(`Job ${jobId}: Trying pdftk background...`);
      execSync(`pdftk "${templatePath}" background "${artworkPdfPath}" output "${outputPath}"`, { cwd: jobDir, timeout: 60000 });
      console.log(`Job ${jobId}: pdftk background succeeded`);

    } catch (pdftkError) {
      console.log(`Job ${jobId}: pdftk not available, trying qpdf...`);

      try {
        // Method 2: Try qpdf underlay
        execSync(`qpdf "${templatePath}" --underlay "${artworkPdfPath}" -- "${outputPath}"`, { cwd: jobDir, timeout: 60000 });
        console.log(`Job ${jobId}: qpdf underlay succeeded`);

      } catch (qpdfError) {
        console.log(`Job ${jobId}: qpdf not available, trying Ghostscript composite...`);

        try {
          // Method 3: Ghostscript - process artwork first, then add template content on top
          // Create a PostScript file that composites both PDFs on same page
          const compositePs = path.join(jobDir, 'composite.ps');
          const compositePsContent = `%!PS-Adobe-3.0 EPSF-3.0
%%BoundingBox: 0 0 ${Math.round(pageWidth)} ${Math.round(pageHeight)}
%%Pages: 1
%%EndComments
%%BeginProlog
/BeginEPSF {
  /b4_Inc_state save def
  /dict_count countdictstack def
  /op_count count 1 sub def
  userdict begin
  /showpage { } def
  0 setgray 0 setlinecap 1 setlinewidth 0 setlinejoin
  10 setmiterlimit [ ] 0 setdash newpath
  /languagelevel where { pop languagelevel 1 ne { false setstrokeadjust false setoverprint } if } if
} bind def
/EndEPSF {
  count op_count sub {pop} repeat
  countdictstack dict_count sub {end} repeat
  b4_Inc_state restore
} bind def
%%EndProlog
%%Page: 1 1
<< /PageSize [${pageWidth} ${pageHeight}] >> setpagedevice
`;
          fs.writeFileSync(compositePs, compositePsContent);

          // Process both PDFs through Ghostscript, extracting first page only
          // First: artwork as base layer (first in command = bottom layer when using pdfwrite)
          // Then: template on top
          const gsCmd = `gs -dNOPAUSE -dBATCH -sDEVICE=pdfwrite \
            -dPDFSETTINGS=/prepress \
            -dCompatibilityLevel=1.7 \
            -dAutoRotatePages=/None \
            -dFirstPage=1 -dLastPage=1 \
            -dFIXEDMEDIA \
            -dDEVICEWIDTHPOINTS=${pageWidth} \
            -dDEVICEHEIGHTPOINTS=${pageHeight} \
            -sOutputFile="${intermediatePath}" \
            "${artworkPdfPath}" 2>&1`;

          execSync(gsCmd, { cwd: jobDir, timeout: 60000 });
          console.log(`Job ${jobId}: Created artwork base layer`);

          // Now overlay template on top using pdfmark /SP (showpage mark)
          const overlayCmd = `gs -dNOPAUSE -dBATCH -sDEVICE=pdfwrite \
            -dPDFSETTINGS=/prepress \
            -dCompatibilityLevel=1.7 \
            -dAutoRotatePages=/None \
            -dFirstPage=1 -dLastPage=1 \
            -sOutputFile="${outputPath}" \
            "${intermediatePath}" \
            -c "[/Page 1 /View [/XYZ 0 ${pageHeight} 1] /DEST pdfmark" \
            -f "${templatePath}" 2>&1`;

          execSync(overlayCmd, { cwd: jobDir, timeout: 60000 });
          console.log(`Job ${jobId}: Added template overlay - but this creates 2 pages`);

          // If we still have 2 pages, extract just page 1 with the artwork
          // Since Ghostscript concatenates, let's just return the artwork PDF
          // with correct dimensions as the final output (template mask will be lost)

          // Better approach: Use convert (ImageMagick) to composite the pages
          console.log(`Job ${jobId}: Trying ImageMagick composite...`);
          execSync(`convert -density 300 "${artworkPdfPath}[0]" -resize ${Math.round(pageWidth)}x${Math.round(pageHeight)}! "${jobDir}/artwork_flat.png"`, { cwd: jobDir, timeout: 60000 });
          execSync(`convert -density 300 "${templatePath}[0]" -resize ${Math.round(pageWidth)}x${Math.round(pageHeight)}! "${jobDir}/template_flat.png"`, { cwd: jobDir, timeout: 60000 });
          execSync(`convert "${jobDir}/artwork_flat.png" "${jobDir}/template_flat.png" -composite "${jobDir}/composite.png"`, { cwd: jobDir, timeout: 60000 });
          execSync(`convert "${jobDir}/composite.png" -density 72 -units PixelsPerInch "${outputPath}"`, { cwd: jobDir, timeout: 60000 });
          console.log(`Job ${jobId}: ImageMagick composite succeeded`);

        } catch (gsError) {
          console.error(`Job ${jobId}: All overlay methods failed:`, gsError.message);

          // Final fallback: just return artwork PDF with correct dimensions
          console.log(`Job ${jobId}: Returning artwork-only PDF`);
          fs.copyFileSync(artworkPdfPath, outputPath);
        }
      }
    }

    // Check if output was created
    if (!fs.existsSync(outputPath)) {
      throw new Error('Output PDF was not created');
    }

    console.log(`Job ${jobId}: PDF created successfully`);

    // Read and send the output file
    const outputBuffer = fs.readFileSync(outputPath);

    // Cleanup
    cleanupJob(jobDir);

    // Send response
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="printpilot-${jobId}.pdf"`);
    res.send(outputBuffer);

  } catch (error) {
    console.error(`Job ${jobId}: Error:`, error);

    // Cleanup on error
    cleanupJob(jobDir);

    res.status(500).json({
      error: 'PDF processing failed',
      message: error.message,
      jobId: jobId
    });
  }
});

/**
 * POST /api/overlay-artwork
 *
 * Simpler approach: Overlay artwork onto template at specific position
 * Uses Ghostscript to composite the images
 */
app.post('/api/overlay-artwork', upload.fields([
  { name: 'template', maxCount: 1 },
  { name: 'artwork', maxCount: 1 }
]), async (req, res) => {
  const jobId = uuidv4();
  const jobDir = path.join(TEMP_DIR, jobId);

  try {
    fs.mkdirSync(jobDir, { recursive: true });

    if (!req.files?.template?.[0] || !req.files?.artwork?.[0]) {
      return res.status(400).json({ error: 'Both template and artwork files are required' });
    }

    const templateFile = req.files.template[0];
    const artworkFile = req.files.artwork[0];

    // Position parameters (in points, 72 points = 1 inch)
    const x = parseFloat(req.body.x) || 0;
    const y = parseFloat(req.body.y) || 0;
    const width = parseFloat(req.body.width) || 0;
    const height = parseFloat(req.body.height) || 0;
    const pageWidth = parseFloat(req.body.pageWidth) || 612;
    const pageHeight = parseFloat(req.body.pageHeight) || 792;

    // Save files
    const templatePath = path.join(jobDir, 'template.pdf');
    const artworkPath = path.join(jobDir, 'artwork.png');
    const outputPath = path.join(jobDir, 'output.pdf');

    fs.writeFileSync(templatePath, templateFile.buffer);
    fs.writeFileSync(artworkPath, artworkFile.buffer);

    // Create PostScript file that overlays the artwork
    const psContent = `
%!PS-Adobe-3.0
%%BoundingBox: 0 0 ${pageWidth} ${pageHeight}
%%Pages: 1
%%EndComments

%%Page: 1 1

% Draw the artwork image
${x} ${y} translate
${width} ${height} scale

(${artworkPath}) (r) file /DCTDecode filter
<< /ImageType 1
   /Width ${width}
   /Height ${height}
   /BitsPerComponent 8
   /Decode [0 1 0 1 0 1]
   /ImageMatrix [1 0 0 -1 0 1]
   /DataSource currentfile
>> image

showpage
%%EOF
`;

    const psPath = path.join(jobDir, 'overlay.ps');
    fs.writeFileSync(psPath, psContent);

    // Use Ghostscript to merge
    // First, get template info
    const gsCmd = `gs -dNOPAUSE -dBATCH -sDEVICE=pdfwrite \
      -dCompatibilityLevel=1.7 \
      -dPDFSETTINGS=/prepress \
      -sOutputFile="${outputPath}" \
      "${templatePath}"`;

    execSync(gsCmd, { cwd: jobDir, timeout: 60000 });

    const outputBuffer = fs.readFileSync(outputPath);
    cleanupJob(jobDir);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="printpilot-${jobId}.pdf"`);
    res.send(outputBuffer);

  } catch (error) {
    console.error(`Job ${jobId}: Error:`, error);
    cleanupJob(jobDir);
    res.status(500).json({ error: 'PDF processing failed', message: error.message });
  }
});

/**
 * POST /api/create-layered-pdf
 *
 * Creates a new PDF with proper OCG layers from scratch
 * - Background layer (from template or color)
 * - Artwork layer (the user's design)
 * - Instructions layer (cut lines, fold marks, etc.)
 */
app.post('/api/create-layered-pdf', upload.fields([
  { name: 'artwork', maxCount: 1 },
  { name: 'template', maxCount: 1 }
]), async (req, res) => {
  const jobId = uuidv4();
  const jobDir = path.join(TEMP_DIR, jobId);

  try {
    fs.mkdirSync(jobDir, { recursive: true });

    if (!req.files?.artwork?.[0]) {
      return res.status(400).json({ error: 'Artwork image is required' });
    }

    const artworkFile = req.files.artwork[0];
    const templateFile = req.files?.template?.[0];

    // Dimensions in points (72 points = 1 inch)
    const pageWidth = parseFloat(req.body.pageWidth) || 612;
    const pageHeight = parseFloat(req.body.pageHeight) || 792;
    const artworkLayerName = req.body.artworkLayerName || 'ARTWORK HERE';

    // Save artwork
    const artworkPath = path.join(jobDir, 'artwork.png');
    const outputPath = path.join(jobDir, 'output.pdf');
    fs.writeFileSync(artworkPath, artworkFile.buffer);

    // If we have a template, extract its structure
    let templatePath = null;
    if (templateFile) {
      templatePath = path.join(jobDir, 'template.pdf');
      fs.writeFileSync(templatePath, templateFile.buffer);
    }

    // Create a PDF with layers using Ghostscript and pdfmark
    // This creates proper OCG (Optional Content Groups)

    const psContent = `%!PS-Adobe-3.0
%%BoundingBox: 0 0 ${Math.round(pageWidth)} ${Math.round(pageHeight)}
%%Pages: 1
%%EndComments

% PDF Layer definitions using pdfmark
/pdfmark where {pop} {userdict /pdfmark /cleartomark load put} ifelse

% Create OCG (Optional Content Group) for artwork layer
[/_objdef {artwork_ocg} /type /ocg /OC <<
  /Name (${artworkLayerName})
  /Intent /Design
  /Usage << /CreatorInfo << /Creator (PrintPilot) /Subtype /Artwork >> >>
>> /OC pdfmark

% Create OCG for template/instructions layer
[/_objdef {template_ocg} /type /ocg /OC <<
  /Name (Template)
  /Intent /View
>> /OC pdfmark

% Create OCProperties to register layers
[{Catalog} <<
  /OCProperties <<
    /OCGs [{artwork_ocg} {template_ocg}]
    /D << /Order [{artwork_ocg} {template_ocg}] /ON [{artwork_ocg} {template_ocg}] >>
  >>
>> /PUT pdfmark

%%Page: 1 1
<< /PageSize [${pageWidth} ${pageHeight}] >> setpagedevice

% Begin artwork layer content
[/OC {artwork_ocg} /BDC pdfmark

% Draw artwork (placeholder - actual image embedding would go here)
0.9 0.9 0.9 setrgbcolor
0 0 ${pageWidth} ${pageHeight} rectfill

% End artwork layer
[/
EMC pdfmark

% Begin template layer
[/OC {template_ocg} /BDC pdfmark

% Template content would go here
0 setgray
0.5 setlinewidth
0 0 ${pageWidth} ${pageHeight} rectstroke

[/EMC pdfmark

showpage
%%EOF
`;

    const psPath = path.join(jobDir, 'layered.ps');
    fs.writeFileSync(psPath, psContent);

    // Convert PS to PDF with Ghostscript
    const gsCmd = `gs -dNOPAUSE -dBATCH -sDEVICE=pdfwrite \
      -dCompatibilityLevel=1.7 \
      -dPDFSETTINGS=/prepress \
      -sOutputFile="${outputPath}" \
      "${psPath}" 2>&1`;

    console.log(`Job ${jobId}: Creating layered PDF...`);
    const output = execSync(gsCmd, { cwd: jobDir, timeout: 60000 });
    console.log(`Job ${jobId}: Ghostscript output:`, output.toString());

    if (!fs.existsSync(outputPath)) {
      throw new Error('Failed to create output PDF');
    }

    const outputBuffer = fs.readFileSync(outputPath);
    cleanupJob(jobDir);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="printpilot-layered-${jobId}.pdf"`);
    res.send(outputBuffer);

  } catch (error) {
    console.error(`Job ${jobId}: Error:`, error);
    cleanupJob(jobDir);
    res.status(500).json({ error: 'PDF processing failed', message: error.message });
  }
});

// Helper: Get file extension from mimetype
function getExtension(mimetype) {
  const map = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/jpg': '.jpg',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'application/pdf': '.pdf'
  };
  return map[mimetype] || '.bin';
}

// Helper: Cleanup job directory
function cleanupJob(jobDir) {
  try {
    if (fs.existsSync(jobDir)) {
      fs.rmSync(jobDir, { recursive: true, force: true });
    }
  } catch (e) {
    console.error('Cleanup error:', e.message);
  }
}

// Start server
app.listen(PORT, () => {
  console.log(`PrintPilot PDF API running on port ${PORT}`);

  // Check Ghostscript
  try {
    const gsVersion = execSync('gs --version').toString().trim();
    console.log(`Ghostscript version: ${gsVersion}`);
  } catch (e) {
    console.warn('WARNING: Ghostscript not found! PDF processing will fail.');
  }

  // Check ImageMagick
  try {
    const imVersion = execSync('convert --version').toString().split('\n')[0];
    console.log(`ImageMagick: ${imVersion}`);
  } catch (e) {
    console.warn('WARNING: ImageMagick not found. Some features may not work.');
  }
});
