# TAFSD-614: build the API Docs PDFs served by the API Docs tile.
#   make          # both
#   make ubl      # one
# Needs Tectonic (brew install tectonic). Commit the PDFs with the .tex changes.
DOCS := ubl attendance-machines

all: $(DOCS)

$(DOCS): %: pdf/%.pdf

pdf/%.pdf: %.tex tafs-api-doc.sty
	@mkdir -p pdf
	tectonic -X compile $< --outdir pdf

.PHONY: all $(DOCS)
