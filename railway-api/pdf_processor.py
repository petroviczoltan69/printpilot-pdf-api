#!/usr/bin/env python3
"""
PDF Processor for PrintPilot
Uses PyMuPDF (fitz) to insert artwork into PDF template layers
Preserves OCG (Optional Content Groups) structure
"""

import sys
import fitz  # PyMuPDF
import json

def find_ocg_by_name(doc, name):
    """Find an OCG (Optional Content Group) by name"""
    try:
        oc_info = doc.get_ocgs()
        if oc_info:
            for xref, ocg in oc_info.items():
                if ocg.get('name', '').upper() == name.upper():
                    return xref
    except Exception as e:
        print(f"Error finding OCG: {e}", file=sys.stderr)
    return None

def list_ocgs(doc):
    """List all OCGs in the document"""
    try:
        oc_info = doc.get_ocgs()
        if oc_info:
            print(f"Found {len(oc_info)} OCG(s):", file=sys.stderr)
            for xref, ocg in oc_info.items():
                print(f"  xref={xref}: {ocg}", file=sys.stderr)
            return oc_info
        else:
            print("No OCGs found in document", file=sys.stderr)
    except Exception as e:
        print(f"Error listing OCGs: {e}", file=sys.stderr)
    return {}

def process_pdf(template_path, artwork_path, output_path, layer_name="ARTWORK HERE"):
    """
    Insert artwork image into the specified layer of the template PDF

    Args:
        template_path: Path to the template PDF with layers
        artwork_path: Path to the artwork image (PNG/JPG)
        output_path: Path for the output PDF
        layer_name: Name of the layer to insert artwork into
    """
    print(f"Opening template: {template_path}", file=sys.stderr)
    doc = fitz.open(template_path)

    # List existing OCGs
    ocgs = list_ocgs(doc)

    # Get first page
    page = doc[0]
    page_rect = page.rect
    print(f"Page size: {page_rect.width} x {page_rect.height} points", file=sys.stderr)

    # Find the target OCG
    target_ocg = find_ocg_by_name(doc, layer_name)

    if target_ocg:
        print(f"Found target layer '{layer_name}' with xref={target_ocg}", file=sys.stderr)
    else:
        print(f"Layer '{layer_name}' not found. Creating new OCG...", file=sys.stderr)
        # Create new OCG for artwork
        target_ocg = doc.add_ocg(layer_name, on=True, intent="Design", usage="Artwork")
        print(f"Created new OCG with xref={target_ocg}", file=sys.stderr)

    # Insert the artwork image
    print(f"Inserting artwork: {artwork_path}", file=sys.stderr)

    # Insert image covering the full page, associated with the OCG
    # The 'oc' parameter associates the image with an Optional Content Group
    try:
        page.insert_image(
            page_rect,  # Full page
            filename=artwork_path,
            oc=target_ocg,  # Associate with OCG layer
            overlay=False,  # Put UNDER existing content (False = below, True = above)
            keep_proportion=False  # Stretch to fill
        )
        print("Artwork inserted successfully", file=sys.stderr)
    except Exception as e:
        print(f"Error inserting image with OCG: {e}", file=sys.stderr)
        # Fallback: insert without OCG
        print("Trying without OCG association...", file=sys.stderr)
        page.insert_image(
            page_rect,
            filename=artwork_path,
            overlay=False,
            keep_proportion=False
        )

    # List OCGs after insertion
    print("OCGs after insertion:", file=sys.stderr)
    list_ocgs(doc)

    # Save the output
    print(f"Saving to: {output_path}", file=sys.stderr)
    doc.save(output_path, garbage=4, deflate=True)
    doc.close()

    print("PDF processing complete!", file=sys.stderr)
    return True

def main():
    if len(sys.argv) < 4:
        print("Usage: python pdf_processor.py <template.pdf> <artwork.png> <output.pdf> [layer_name]", file=sys.stderr)
        sys.exit(1)

    template_path = sys.argv[1]
    artwork_path = sys.argv[2]
    output_path = sys.argv[3]
    layer_name = sys.argv[4] if len(sys.argv) > 4 else "ARTWORK HERE"

    try:
        success = process_pdf(template_path, artwork_path, output_path, layer_name)
        if success:
            print(json.dumps({"success": True, "output": output_path}))
            sys.exit(0)
        else:
            print(json.dumps({"success": False, "error": "Processing failed"}))
            sys.exit(1)
    except Exception as e:
        print(json.dumps({"success": False, "error": str(e)}))
        sys.exit(1)

if __name__ == "__main__":
    main()
