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
    """Find an OCG (Optional Content Group) by name, return first match"""
    try:
        oc_info = doc.get_ocgs()
        if oc_info:
            for xref, ocg in oc_info.items():
                ocg_name = ocg.get('name', '').upper()
                if name.upper() in ocg_name or ocg_name in name.upper():
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
                print(f"  xref={xref}: {ocg.get('name', 'unnamed')}", file=sys.stderr)
            return oc_info
        else:
            print("No OCGs found in document", file=sys.stderr)
    except Exception as e:
        print(f"Error listing OCGs: {e}", file=sys.stderr)
    return {}

def process_pdf(template_path, artwork_path, output_path, layer_name="ARTWORK HERE"):
    """
    Insert artwork image into the specified layer of the template PDF
    """
    print(f"Opening template: {template_path}", file=sys.stderr)
    doc = fitz.open(template_path)

    # List existing OCGs
    ocgs = list_ocgs(doc)

    # Get first page
    page = doc[0]
    page_rect = page.rect
    print(f"Page size: {page_rect.width} x {page_rect.height} points", file=sys.stderr)

    # Find the target OCG - "ARTWORK HERE"
    artwork_ocg = find_ocg_by_name(doc, "ARTWORK")
    template_ocg = find_ocg_by_name(doc, "TEMPLATE MASK")
    background_ocg = find_ocg_by_name(doc, "BACKGROUND")

    print(f"Found layers - ARTWORK: {artwork_ocg}, TEMPLATE: {template_ocg}, BACKGROUND: {background_ocg}", file=sys.stderr)

    if artwork_ocg:
        print(f"Using existing ARTWORK layer xref={artwork_ocg}", file=sys.stderr)
        target_ocg = artwork_ocg
    else:
        print(f"ARTWORK layer not found, creating new one", file=sys.stderr)
        target_ocg = doc.add_ocg(layer_name, on=True, intent="Design", usage="Artwork")

    # Insert the artwork image with OCG association
    print(f"Inserting artwork: {artwork_path}", file=sys.stderr)

    try:
        # Insert image and get its xref
        # overlay=False puts it UNDER existing content
        img_xref = page.insert_image(
            page_rect,
            filename=artwork_path,
            overlay=False,  # Below existing content
            keep_proportion=False
        )
        print(f"Image inserted with xref={img_xref}", file=sys.stderr)

        # Associate the image with the ARTWORK OCG layer
        if img_xref and target_ocg:
            doc.set_oc(img_xref, target_ocg)
            print(f"Image associated with OCG layer xref={target_ocg}", file=sys.stderr)

    except Exception as e:
        print(f"Error inserting image: {e}", file=sys.stderr)
        # Try alternative method
        print("Trying alternative insertion method...", file=sys.stderr)
        page.insert_image(
            page_rect,
            filename=artwork_path,
            overlay=False,
            keep_proportion=False,
            oc=target_ocg  # Direct OCG parameter
        )

    # Verify OCGs after modification
    print("\nFinal OCG structure:", file=sys.stderr)
    list_ocgs(doc)

    # Save - preserve structure
    print(f"Saving to: {output_path}", file=sys.stderr)
    doc.save(output_path, garbage=0, deflate=True, clean=False)
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
