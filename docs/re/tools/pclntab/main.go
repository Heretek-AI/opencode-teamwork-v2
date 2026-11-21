// Command pclntab recovers Go function names and entry PCs from the pclntab
// embedded in a stripped ELF binary.
//
// It does not assume a section name (modern builds often bury the table inside
// .lrodata or .rodata). It scans every section's bytes for a plausible pcHeader,
// validates the header and the executable text range, then emits one line per
// function:
//
//	0x<entry-pc>\t<name>
//
// The preferred parser is debug/gosym (the local toolchain's Go 1.20 reader,
// which still understands the Go 1.28 layout). If gosym rejects or truncates
// the table, the tool falls back to a hand-written Go 1.20+ pcHeader/functab
// walker. A "parser=gosym" or "parser=manual" line is written to stderr so
// downstream analysis can record which path ran.
package main

import (
	"bufio"
	"bytes"
	"debug/elf"
	"debug/gosym"
	"encoding/binary"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"sort"
	"strings"
)

const (
	// pcHeaderSize is the size of the Go 1.20+ pcHeader: 8 fixed bytes plus
	// eight pointer-sized fields (nfunc, nfiles, and six offsets). The field
	// that used to hold textStart is still present for compatibility but is
	// zeroed since Go 1.27 (it would require a relocation); the real text
	// base comes from moduledata.text.
	pcHeaderSize = 72

	// minFuncs is the sanity floor used to reject random magic matches.
	minFuncs = 1000
)

// pcHeader mirrors runtime.pcHeader (Go 1.20+ layout).
type pcHeader struct {
	Magic          uint32
	Pad1           uint8
	Pad2           uint8
	MinLC          uint8
	PtrSize        uint8
	NFunc          uint64
	NFiles         uint64
	TextStartField uint64 // stored field; zero/unused in Go 1.27+
	FuncnameOffset uint64
	CUOffset       uint64
	FiletabOffset  uint64
	PctabOffset    uint64
	PclnOffset     uint64
}

// location describes the section and offset where a validated pclntab lives.
type location struct {
	secName  string
	secIndex int
	secAddr  uint64
	secOff   uint64
	secSize  uint64
	fileOff  uint64 // absolute file offset of the pcHeader magic
	data     []byte // pcHeader magic through the end of the section
	bo       binary.ByteOrder
	hdr      pcHeader
	textBase uint64
	textSrc  string
}

// execRange is an SHF_EXECINSTR section.
type execRange struct {
	name string
	addr uint64
	size uint64
}

// fn is one recovered function.
type fn struct {
	entry uint64
	name  string
}

// stringList implements a repeatable string flag.
type stringList []string

func (s *stringList) String() string { return strings.Join(*s, ",") }

func (s *stringList) Set(v string) error {
	*s = append(*s, v)
	return nil
}

func main() {
	// Last-resort guard: malformed input must produce a one-line error, not a
	// panic trace. All normal paths return errors explicitly.
	err := func() (err error) {
		defer func() {
			if r := recover(); r != nil {
				err = fmt.Errorf("internal panic: %v", r)
			}
		}()
		return run()
	}()
	if err != nil {
		fmt.Fprintln(os.Stderr, "pclntab:", oneLine(err.Error()))
		os.Exit(1)
	}
}

func run() error {
	var (
		binPath string
		outPath string
		filters stringList
		header  bool
		limit   int
	)
	flag.StringVar(&binPath, "bin", "", "path to the stripped ELF binary (required)")
	flag.StringVar(&outPath, "out", "", "write output to this file instead of stdout")
	flag.Var(&filters, "filter", "case-sensitive substring filter; repeatable (empty matches all)")
	flag.BoolVar(&header, "header", false, "print the decoded header and chosen section, then exit")
	flag.IntVar(&limit, "limit", 0, "cap the number of printed lines (0 = unlimited)")
	flag.Parse()

	if binPath == "" {
		return errors.New("-bin is required")
	}
	if limit < 0 {
		return errors.New("-limit must be >= 0")
	}

	osf, err := os.Open(binPath)
	if err != nil {
		return fmt.Errorf("open %s: %w", binPath, err)
	}
	defer osf.Close()

	ef, err := elf.NewFile(osf)
	if err != nil {
		return fmt.Errorf("parse ELF %s: %w", binPath, err)
	}
	defer ef.Close()

	loc, err := locatePclntab(ef)
	if err != nil {
		return err
	}

	w, closeOut, err := openOutput(outPath)
	if err != nil {
		return err
	}
	bw := bufio.NewWriterSize(w, 1<<20)

	writeErr := func() error {
		if header {
			printHeader(bw, loc)
			return nil
		}

		funcs, parser, parseErr := recoverFuncs(loc)
		if parseErr != nil {
			return parseErr
		}
		fmt.Fprintf(os.Stderr, "parser=%s\n", parser)
		if parser == "manual" {
			fmt.Fprintf(os.Stderr, "note=gosym rejected the table; used manual pcHeader walker\n")
		}

		writeFuncs(bw, funcs, filters, limit)
		return nil
	}()

	flushErr := bw.Flush()
	if writeErr != nil {
		closeOut()
		return writeErr
	}
	if flushErr != nil {
		closeOut()
		return fmt.Errorf("flush output: %w", flushErr)
	}
	if err := closeOut(); err != nil {
		return fmt.Errorf("close output: %w", err)
	}
	return nil
}

func openOutput(path string) (io.Writer, func() error, error) {
	if path == "" {
		return os.Stdout, func() error { return nil }, nil
	}
	f, err := os.Create(path)
	if err != nil {
		return nil, nil, fmt.Errorf("create %s: %w", path, err)
	}
	return f, f.Close, nil
}

// locatePclntab scans every section's bytes for a valid pcHeader.
func locatePclntab(ef *elf.File) (*location, error) {
	execs := execRanges(ef)
	if len(execs) == 0 {
		return nil, errors.New("no SHF_EXECINSTR section found")
	}

	for i, sec := range ef.Sections {
		// NOBITS and NULL have no meaningful file bytes.
		if sec.Type == elf.SHT_NOBITS || sec.Type == elf.SHT_NULL {
			continue
		}
		if sec.FileSize < pcHeaderSize {
			continue
		}
		data, err := sec.Data()
		if err != nil || uint64(len(data)) < pcHeaderSize {
			continue // one unreadable section must not abort the scan
		}

		for _, off := range findMagics(data, ef.ByteOrder) {
			rest := data[off:]
			h, err := parsePCHeader(rest, ef.ByteOrder)
			if err != nil {
				continue
			}
			if err := validateHeader(h, rest); err != nil {
				continue
			}
			base, src := deriveTextBase(h, rest, execs, ef.ByteOrder)
			if base == 0 {
				continue
			}
			return &location{
				secName:  sec.Name,
				secIndex: i,
				secAddr:  sec.Addr,
				secOff:   sec.Offset,
				secSize:  sec.Size,
				fileOff:  sec.Offset + uint64(off),
				data:     rest,
				bo:       ef.ByteOrder,
				hdr:      h,
				textBase: base,
				textSrc:  src,
			}, nil
		}
	}
	return nil, errors.New("no valid pclntab pcHeader found in any section (tried magic fffffff1, fffffff0, fffffffa)")
}

// findMagics returns offsets of all candidate 4-byte magics, ascending.
func findMagics(buf []byte, bo binary.ByteOrder) []int {
	var offs []int
	for _, m := range []uint32{0xfffffff1, 0xfffffff0, 0xfffffffa} {
		var pat [4]byte
		bo.PutUint32(pat[:], m)
		start := 0
		for {
			k := bytes.Index(buf[start:], pat[:])
			if k < 0 {
				break
			}
			offs = append(offs, start+k)
			start += k + 1
		}
	}
	sort.Ints(offs)
	return offs
}

func parsePCHeader(b []byte, bo binary.ByteOrder) (pcHeader, error) {
	if len(b) < pcHeaderSize {
		return pcHeader{}, errors.New("short pcHeader")
	}
	h := pcHeader{
		Magic:          bo.Uint32(b[0:]),
		Pad1:           b[4],
		Pad2:           b[5],
		MinLC:          b[6],
		PtrSize:        b[7],
		NFunc:          bo.Uint64(b[8:]),
		NFiles:         bo.Uint64(b[16:]),
		TextStartField: bo.Uint64(b[24:]),
		FuncnameOffset: bo.Uint64(b[32:]),
		CUOffset:       bo.Uint64(b[40:]),
		FiletabOffset:  bo.Uint64(b[48:]),
		PctabOffset:    bo.Uint64(b[56:]),
		PclnOffset:     bo.Uint64(b[64:]),
	}
	if h.Magic != 0xfffffff1 && h.Magic != 0xfffffff0 && h.Magic != 0xfffffffa {
		return pcHeader{}, errors.New("bad magic")
	}
	return h, nil
}

func validateHeader(h pcHeader, data []byte) error {
	if h.Pad1 != 0 || h.Pad2 != 0 {
		return errors.New("nonzero header padding")
	}
	if h.MinLC != 1 {
		return fmt.Errorf("minLC=%d, want 1", h.MinLC)
	}
	if h.PtrSize != 8 {
		return fmt.Errorf("ptrSize=%d, want 8", h.PtrSize)
	}
	if h.NFunc <= minFuncs {
		return fmt.Errorf("nfunc=%d, want > %d", h.NFunc, minFuncs)
	}
	if h.NFiles == 0 {
		return errors.New("nfiles=0")
	}
	n := uint64(len(data))
	if h.FuncnameOffset < pcHeaderSize || h.FuncnameOffset >= n {
		return fmt.Errorf("funcnameOffset=0x%x out of range", h.FuncnameOffset)
	}
	if h.PclnOffset < pcHeaderSize || h.PclnOffset >= n {
		return fmt.Errorf("pclnOffset=0x%x out of range", h.PclnOffset)
	}
	// The ftab is nfunc {entryoff,funcoff} pairs plus one sentinel entryoff.
	if h.NFunc > (n-4)/8 {
		return fmt.Errorf("nfunc=%d larger than table", h.NFunc)
	}
	end := h.PclnOffset + h.NFunc*8 + 4
	if end > n {
		return fmt.Errorf("ftab end 0x%x past section end 0x%x", end, n)
	}
	return nil
}

// deriveTextBase finds the runtime.text base. Go 1.27+ zeroes the header's
// textStart field, so the base is inferred from executable sections and
// cross-checked against the first and last functab entry offsets.
func deriveTextBase(h pcHeader, data []byte, execs []execRange, bo binary.ByteOrder) (uint64, string) {
	off0 := h.PclnOffset
	offLast := h.PclnOffset + (h.NFunc-1)*8
	if offLast+4 > uint64(len(data)) {
		return 0, ""
	}
	e0 := uint64(bo.Uint32(data[off0:]))
	eN := uint64(bo.Uint32(data[offLast:]))

	type cand struct {
		addr uint64
		src  string
	}
	var cands []cand
	if h.TextStartField != 0 {
		cands = append(cands, cand{h.TextStartField, "header textStart"})
	}
	// Prefer the canonical .text section, then the largest executable section.
	for _, e := range execs {
		if e.name == ".text" {
			cands = append(cands, cand{e.addr, "section " + e.name})
			break
		}
	}
	sorted := append([]execRange(nil), execs...)
	sort.Slice(sorted, func(i, j int) bool {
		if sorted[i].size != sorted[j].size {
			return sorted[i].size > sorted[j].size
		}
		return sorted[i].addr < sorted[j].addr
	})
	for _, e := range sorted {
		cands = append(cands, cand{e.addr, "section " + e.name})
	}

	seen := make(map[uint64]bool)
	for _, c := range cands {
		if seen[c.addr] {
			continue
		}
		seen[c.addr] = true
		if inExec(c.addr+e0, execs) && inExec(c.addr+eN, execs) {
			return c.addr, c.src
		}
	}
	return 0, ""
}

func inExec(pc uint64, execs []execRange) bool {
	for _, e := range execs {
		if pc >= e.addr && pc < e.addr+e.size {
			return true
		}
	}
	return false
}

func execRanges(ef *elf.File) []execRange {
	var out []execRange
	for _, s := range ef.Sections {
		if s.Flags&elf.SHF_EXECINSTR == 0 || s.Size == 0 {
			continue
		}
		out = append(out, execRange{name: s.Name, addr: s.Addr, size: s.Size})
	}
	return out
}

// recoverFuncs tries gosym first, then the manual walker.
func recoverFuncs(loc *location) ([]fn, string, error) {
	funcs, err := funcsViaGosym(loc)
	if err == nil {
		return funcs, "gosym", nil
	}
	funcs, merr := funcsManual(loc)
	if merr != nil {
		return nil, "", fmt.Errorf("gosym: %v; manual: %v", oneLine(err.Error()), oneLine(merr.Error()))
	}
	return funcs, "manual", nil
}

// funcsViaGosym uses debug/gosym. It is guarded with recover because gosym's
// parser is documented to panic on malformed tables and recover internally in
// some, but not all, paths.
func funcsViaGosym(loc *location) (funcs []fn, err error) {
	defer func() {
		if r := recover(); r != nil {
			funcs = nil
			err = fmt.Errorf("panic: %v", r)
		}
	}()

	lt := gosym.NewLineTable(loc.data, loc.textBase)
	tab, err := gosym.NewTable(nil, lt)
	if err != nil {
		return nil, err
	}
	if uint64(len(tab.Funcs)) != loc.hdr.NFunc {
		return nil, fmt.Errorf("returned %d funcs, header says %d", len(tab.Funcs), loc.hdr.NFunc)
	}
	funcs = make([]fn, 0, len(tab.Funcs))
	for _, f := range tab.Funcs {
		if f.Sym == nil {
			continue
		}
		funcs = append(funcs, fn{entry: f.Entry, name: f.Sym.Name})
	}
	if len(funcs) == 0 {
		return nil, errors.New("returned no functions")
	}
	return funcs, nil
}

// funcsManual walks the Go 1.20+ pcHeader/functab directly.
//
// Layout inside loc.data (which starts at the pcHeader magic):
//
//	pcHeader
//	funcnametab at FuncnameOffset
//	cutab, filetab, pctab
//	functab at PclnOffset: nfunc pairs of {entryoff u32, funcoff u32},
//	                        then one sentinel entryoff u32
//	_func structs at PclnOffset+funcoff, each starting with
//	                        {entryoff u32, nameoff i32}
func funcsManual(loc *location) ([]fn, error) {
	h := loc.hdr
	data := loc.data
	bo := loc.bo

	names := data[h.FuncnameOffset:]
	nfunc := h.NFunc
	ftab := h.PclnOffset

	funcs := make([]fn, 0, nfunc)
	for i := uint64(0); i < nfunc; i++ {
		entOff := ftab + i*8
		entryOff := uint64(bo.Uint32(data[entOff:]))
		funcOff := uint64(bo.Uint32(data[entOff+4:]))

		abs := ftab + funcOff
		if abs+8 > uint64(len(data)) {
			return nil, fmt.Errorf("func %d: _func offset 0x%x out of range", i, abs)
		}
		nameOff := uint64(bo.Uint32(data[abs+4:]))
		if nameOff >= uint64(len(names)) {
			return nil, fmt.Errorf("func %d: name offset 0x%x out of range", i, nameOff)
		}
		end := bytes.IndexByte(names[nameOff:], 0)
		if end < 0 {
			return nil, fmt.Errorf("func %d: unterminated name at 0x%x", i, nameOff)
		}
		name := string(names[nameOff : nameOff+uint64(end)])

		funcs = append(funcs, fn{entry: loc.textBase + entryOff, name: name})
	}
	if len(funcs) == 0 {
		return nil, errors.New("table contained no functions")
	}
	return funcs, nil
}

func writeFuncs(w *bufio.Writer, funcs []fn, filters []string, limit int) {
	sort.SliceStable(funcs, func(i, j int) bool {
		if funcs[i].entry != funcs[j].entry {
			return funcs[i].entry < funcs[j].entry
		}
		return funcs[i].name < funcs[j].name
	})

	printed := 0
	for _, f := range funcs {
		if !matches(f.name, filters) {
			continue
		}
		fmt.Fprintf(w, "0x%x\t%s\n", f.entry, f.name)
		printed++
		if limit > 0 && printed >= limit {
			break
		}
	}
}

func matches(name string, filters []string) bool {
	if len(filters) == 0 {
		return true
	}
	for _, f := range filters {
		if f == "" || strings.Contains(name, f) {
			return true
		}
	}
	return false
}

func printHeader(w io.Writer, loc *location) {
	h := loc.hdr
	fmt.Fprintf(w, "section\t\t%s\n", loc.secName)
	fmt.Fprintf(w, "section_index\t%d\n", loc.secIndex)
	fmt.Fprintf(w, "section_addr\t0x%x\n", loc.secAddr)
	fmt.Fprintf(w, "section_offset\t0x%x\n", loc.secOff)
	fmt.Fprintf(w, "section_size\t0x%x\n", loc.secSize)
	fmt.Fprintf(w, "pclntab_offset\t0x%x\n", loc.fileOff)
	fmt.Fprintf(w, "pclntab_size\t0x%x\n", uint64(len(loc.data)))
	fmt.Fprintf(w, "magic\t0x%08x\n", h.Magic)
	fmt.Fprintf(w, "pad1\t%d\n", h.Pad1)
	fmt.Fprintf(w, "pad2\t%d\n", h.Pad2)
	fmt.Fprintf(w, "minLC\t%d\n", h.MinLC)
	fmt.Fprintf(w, "ptrSize\t%d\n", h.PtrSize)
	fmt.Fprintf(w, "nfunc\t%d\n", h.NFunc)
	fmt.Fprintf(w, "nfiles\t%d\n", h.NFiles)
	fmt.Fprintf(w, "textStart\t0x%x\n", h.TextStartField)
	fmt.Fprintf(w, "funcnameOffset\t0x%x\n", h.FuncnameOffset)
	fmt.Fprintf(w, "cuOffset\t0x%x\n", h.CUOffset)
	fmt.Fprintf(w, "filetabOffset\t0x%x\n", h.FiletabOffset)
	fmt.Fprintf(w, "pctabOffset\t0x%x\n", h.PctabOffset)
	fmt.Fprintf(w, "pclnOffset\t0x%x\n", h.PclnOffset)
	fmt.Fprintf(w, "textBase\t0x%x\n", loc.textBase)
	fmt.Fprintf(w, "textBaseSource\t%s\n", loc.textSrc)
	if h.TextStartField == 0 {
		fmt.Fprintf(w, "note\ttextStart field is zero/unused (Go 1.27+); textBase inferred from %s\n", loc.textSrc)
	}
}

func oneLine(s string) string {
	s = strings.ReplaceAll(s, "\r", " ")
	s = strings.ReplaceAll(s, "\n", " ")
	return strings.TrimSpace(s)
}
