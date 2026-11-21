// Command strhdr decodes Go string headers out of a stripped ELF binary whose
// pointer fields are RELA-relocated.
//
// A Go string value is a 16-byte header {ptr, len}. In a PIE linked with RELA
// relocations the pointer is stored as zero on disk and its true value lives in
// the addend of the R_X86_64_RELATIVE entry in .rela.dyn that applies to the
// header's virtual address. So the header at virtual address A decodes as:
//
//	ptr    = addend of the .rela.dyn entry with r_offset == A
//	         (falling back to the in-place u64 when no such entry exists)
//	len    = u64 at A+8
//
// The tool is deliberately read-only: it maps virtual addresses to file offsets
// through the PT_LOAD program headers, never writes to the target and never
// executes it. Anything it cannot confidently decode is reported as
// "<non-string>" instead of being hidden, so alignment mistakes are visible.
//
// Usage:
//
//	strhdr -bin ./binary -struct 0xd8101c0 -fields 12
//	strhdr -bin ./binary -addr 0xd8101c0
//	strhdr -bin ./binary -raw 0xd8101c0
//	strhdr -bin ./binary -agent 0xd810280
//	strhdr -bin ./binary -compact -agent 0xd810280 -agent 0xd812e00
package main

import (
	"debug/elf"
	"encoding/binary"
	"flag"
	"fmt"
	"os"
	"sort"
	"strings"
	"unicode/utf8"
)

const (
	// stringHeaderSize is the on-disk size of a Go string value.
	stringHeaderSize = 16

	// maxStringLen bounds how many bytes are read for one value. Longer
	// "lengths" are almost always misaligned reads, not real strings.
	maxStringLen = 20000

	// maxFields bounds -fields so a typo cannot turn into a huge run.
	maxFields = 4096

	// relaEntrySize is the size of an Elf64_Rela.
	relaEntrySize = 24

	// Offsets inside a teamwork agent item struct, verified on the
	// armed_worker entry at 0xd810280.
	agentOffName  = 0x00 // Go string: short name
	agentOffType  = 0x10 // Go string: runtime type
	agentOffDesc  = 0x20 // Go string: description
	agentOffTools = 0x40 // Go slice {ptr, len, cap} of Go strings

	// maxTools bounds the allowlist length; anything larger is a
	// misaligned read rather than a real tool slice.
	maxTools = 100
)

// agentIntOffsets are the u64 slots whose meaning is not yet known. They are
// printed verbatim by -int-fields instead of being guessed at.
var agentIntOffsets = []uint64{0x30, 0x38, 0x58, 0x60, 0x68, 0x70, 0x78, 0x80, 0x88}

// agentRecord is one decoded agent item. Decode errors are carried instead of
// aborting so a bad address never stops the run.
type agentRecord struct {
	addr uint64

	name, typ      string
	nameOK, typeOK bool

	tools        []string
	toolsOK      bool
	toolsPtr     uint64
	toolsLen     uint64
	toolsCap     uint64
	toolsProblem string

	ints    []uint64
	intsOK  bool
	intsErr error
}

// addrFlags collects a repeatable hexadecimal address flag.
type addrFlags []uint64

func (a *addrFlags) String() string {
	var b strings.Builder
	for i, v := range *a {
		if i > 0 {
			b.WriteString(",")
		}
		fmt.Fprintf(&b, "0x%x", v)
	}
	return b.String()
}

func (a *addrFlags) Set(s string) error {
	v, err := parseAddr(s)
	if err != nil {
		return err
	}
	*a = append(*a, v)
	return nil
}

// parseAddr accepts 0x-prefixed hexadecimal or plain decimal, with optional
// underscores, and rejects anything that would overflow a uint64.
func parseAddr(s string) (uint64, error) {
	t := strings.TrimSpace(s)
	if t == "" {
		return 0, fmt.Errorf("empty address")
	}
	base := uint64(10)
	if len(t) > 2 && t[0] == '0' && (t[1] == 'x' || t[1] == 'X') {
		base = 16
		t = t[2:]
	}
	var (
		v      uint64
		digits int
	)
	for _, c := range t {
		if c == '_' {
			continue
		}
		var d uint64
		switch {
		case c >= '0' && c <= '9':
			d = uint64(c - '0')
		case base == 16 && c >= 'a' && c <= 'f':
			d = uint64(c-'a') + 10
		case base == 16 && c >= 'A' && c <= 'F':
			d = uint64(c-'A') + 10
		default:
			return 0, fmt.Errorf("address %q: invalid character %q", s, c)
		}
		if v > (^uint64(0)-d)/base {
			return 0, fmt.Errorf("address %q overflows uint64", s)
		}
		v = v*base + d
		digits++
	}
	if digits == 0 {
		return 0, fmt.Errorf("address %q has no digits", s)
	}
	return v, nil
}

// image wraps the target file plus the lazily built relocation map.
type image struct {
	f      *elf.File
	src    *os.File // kept for ReadAt; must outlive f
	order  binary.ByteOrder
	relocs map[uint64]uint64 // r_offset -> r_addend for R_X86_64_RELATIVE
	nRelas int               // total entries seen in .rela.dyn
}

// segment maps a virtual address range onto a file offset range.
type segment struct {
	vaddr  uint64
	offset uint64
	filesz uint64
}

// loadRelocs reads .rela.dyn and records every R_X86_64_RELATIVE addend.
// A single sequential scan is enough; the section is ~25 MB in this build.
func (im *image) loadRelocs() error {
	sec := im.f.Section(".rela.dyn")
	if sec == nil {
		for _, s := range im.f.Sections {
			if s.Type == elf.SHT_RELA && s.Flags&elf.SHF_ALLOC != 0 {
				sec = s
				break
			}
		}
	}
	if sec == nil {
		return fmt.Errorf("no RELA section found")
	}
	data, err := sec.Data()
	if err != nil {
		return fmt.Errorf("read %s: %w", sec.Name, err)
	}
	if len(data)%relaEntrySize != 0 {
		fmt.Fprintf(os.Stderr, "strhdr: warning: %s size 0x%x is not a multiple of %d; ignoring tail\n",
			sec.Name, len(data), relaEntrySize)
	}
	im.relocs = make(map[uint64]uint64, 1<<20)
	im.nRelas = len(data) / relaEntrySize
	for off := 0; off+relaEntrySize <= len(data); off += relaEntrySize {
		rOffset := im.order.Uint64(data[off:])
		rInfo := im.order.Uint64(data[off+8:])
		rAddend := im.order.Uint64(data[off+16:])
		if im.f.Machine == elf.EM_X86_64 && uint32(rInfo) != uint32(elf.R_X86_64_RELATIVE) {
			continue
		}
		im.relocs[rOffset] = rAddend
	}
	if im.relocs == nil || len(im.relocs) == 0 {
		return fmt.Errorf("%s contained no usable RELATIVE relocations", sec.Name)
	}
	fmt.Fprintf(os.Stderr, "strhdr: %s: %d entries, %d relocations indexed\n",
		sec.Name, im.nRelas, len(im.relocs))
	return nil
}

// fileOffset maps a virtual address to a file offset via PT_LOAD and reports
// how many contiguous bytes are readable from there.
func (im *image) fileOffset(v uint64) (int64, uint64, bool) {
	for _, p := range im.f.Progs {
		if p.Type != elf.PT_LOAD || p.Filesz == 0 {
			continue
		}
		if v >= p.Vaddr && v < p.Vaddr+p.Filesz {
			return int64(p.Off + (v - p.Vaddr)), p.Filesz - (v - p.Vaddr), true
		}
	}
	return 0, 0, false
}

// readAt copies exactly n bytes at virtual address v.
func (im *image) readAt(v uint64, n uint64) ([]byte, error) {
	off, avail, ok := im.fileOffset(v)
	if !ok {
		return nil, fmt.Errorf("virtual address 0x%x is not in any PT_LOAD segment", v)
	}
	if avail < n {
		return nil, fmt.Errorf("virtual address 0x%x: only 0x%x bytes readable, need 0x%x", v, avail, n)
	}
	buf := make([]byte, n)
	if _, err := im.src.ReadAt(buf, off); err != nil {
		return nil, fmt.Errorf("read 0x%x bytes at 0x%x (file offset 0x%x): %w", n, v, off, err)
	}
	return buf, nil
}

// u64 reads a little-endian u64 at a virtual address.
func (im *image) u64(v uint64) (uint64, error) {
	b, err := im.readAt(v, 8)
	if err != nil {
		return 0, err
	}
	return im.order.Uint64(b), nil
}

// sectionAt returns the narrowest allocated section containing [v, v+size).
// Objects are often placed inside a larger container section, so the narrowest
// match is the most informative name.
func (im *image) sectionAt(v, size uint64) (name string, base uint64, ok bool) {
	var bestSize uint64
	for _, s := range im.f.Sections {
		if s.Type == elf.SHT_NOBITS || s.Size == 0 || s.Addr == 0 {
			continue
		}
		if v < s.Addr || v+size < v {
			continue
		}
		if v+size > s.Addr+s.Size {
			continue
		}
		if !ok || s.Size < bestSize {
			name, base, ok, bestSize = s.Name, s.Addr, true, s.Size
		}
	}
	return name, base, ok
}

// nearestSection describes where v fell when sectionAt found nothing.
func (im *image) nearestSection(v uint64) string {
	var (
		best *elf.Section
	)
	for _, s := range im.f.Sections {
		if s.Addr == 0 || s.Size == 0 {
			continue
		}
		if s.Addr > v {
			continue
		}
		if best == nil || s.Addr > best.Addr {
			best = s
		}
	}
	if best == nil {
		return "no section at or below this address"
	}
	return fmt.Sprintf("nearest section %s ends at 0x%x", best.Name, best.Addr+best.Size)
}

// describeAddr renders "section+offset" for diagnostics.
func (im *image) describeAddr(v uint64) string {
	name, base, ok := im.sectionAt(v, 1)
	if !ok {
		return "<no section> (" + im.nearestSection(v) + ")"
	}
	return fmt.Sprintf("%s+0x%x", name, v-base)
}

// resolved is the outcome of decoding one header.
type resolved struct {
	ptr    uint64
	length uint64
	reloc  bool
}

// header reads the 16-byte header at A and resolves the pointer.
func (im *image) header(a uint64) (resolved, error) {
	buf, err := im.readAt(a, stringHeaderSize)
	if err != nil {
		return resolved{}, err
	}
	inPlace := im.order.Uint64(buf[0:8])
	length := im.order.Uint64(buf[8:16])
	if add, ok := im.relocs[a]; ok {
		return resolved{ptr: add, length: length, reloc: true}, nil
	}
	return resolved{ptr: inPlace, length: length}, nil
}

// printString decodes and prints one string header at address a with field idx.
func (im *image) printString(a uint64, idx int) {
	r, err := im.header(a)
	if err != nil {
		fmt.Printf("addr=0x%x field=%d error=%q <non-string>\n", a, idx, err.Error())
		return
	}
	if r.length == 0 || r.length > maxStringLen {
		fmt.Printf("addr=0x%x field=%d len=%d <non-string>\n", a, idx, r.length)
		return
	}
	raw, err := im.readAt(r.ptr, r.length)
	if err != nil {
		fmt.Fprintf(os.Stderr, "strhdr: addr=0x%x field=%d: %v\n", a, idx, err)
		fmt.Printf("addr=0x%x field=%d len=%d <non-string>\n", a, idx, r.length)
		return
	}
	if !utf8.Valid(raw) {
		fmt.Printf("addr=0x%x field=%d len=%d <non-string>\n", a, idx, r.length)
		return
	}
	fmt.Printf("addr=0x%x field=%d ptr=0x%x len=%d %q\n", a, idx, r.ptr, r.length, string(raw))
}

// goStringAt decodes one Go string value at a, returning a descriptive error
// when the header cannot be trusted as a string.
func (im *image) goStringAt(a uint64) (string, error) {
	r, err := im.header(a)
	if err != nil {
		return "", err
	}
	if r.length == 0 {
		return "", nil
	}
	if r.length > maxStringLen {
		return "", fmt.Errorf("length %d exceeds %d", r.length, maxStringLen)
	}
	raw, err := im.readAt(r.ptr, r.length)
	if err != nil {
		return "", err
	}
	if !utf8.Valid(raw) {
		return "", fmt.Errorf("value at 0x%x is not valid UTF-8", r.ptr)
	}
	return string(raw), nil
}

// inDataSection reports whether [ptr, ptr+size) lies in .data or .data.rel.ro.
// Pointers elsewhere are not plausible for a static agent item in this build.
func (im *image) inDataSection(ptr, size uint64) bool {
	name, _, ok := im.sectionAt(ptr, size)
	if !ok {
		return false
	}
	return name == ".data" || name == ".data.rel.ro" || strings.HasPrefix(name, ".data.rel.ro.")
}

// decodeAgent decodes an agent item at a. It never panics: every failure is
// recorded on the returned record and printing continues.
func (im *image) decodeAgent(a uint64) *agentRecord {
	rec := &agentRecord{addr: a, intsOK: true}

	if s, err := im.goStringAt(a + agentOffName); err == nil {
		rec.name, rec.nameOK = s, true
	}
	if s, err := im.goStringAt(a + agentOffType); err == nil {
		rec.typ, rec.typeOK = s, true
	}

	ptrAt := a + agentOffTools
	if ptr, err := im.u64(ptrAt); err == nil {
		if add, ok := im.relocs[ptrAt]; ok {
			ptr = add
		}
		length, lerr := im.u64(ptrAt + 8)
		capacity, cerr := im.u64(ptrAt + 16)
		rec.toolsPtr, rec.toolsLen, rec.toolsCap = ptr, length, capacity
		switch {
		case lerr != nil:
			rec.toolsProblem = fmt.Sprintf("len read failed: %v", lerr)
		case cerr != nil:
			rec.toolsProblem = fmt.Sprintf("cap read failed: %v", cerr)
		case length > maxTools:
			rec.toolsProblem = "len exceeds " + fmt.Sprint(maxTools)
		case length == 0 && ptr == 0:
			rec.toolsOK = true
		case !im.inDataSection(ptr, stringHeaderSize):
			rec.toolsProblem = fmt.Sprintf("ptr 0x%x is outside .data/.data.rel.ro", ptr)
		case capacity < length:
			rec.toolsProblem = fmt.Sprintf("cap %d < len %d", capacity, length)
		default:
			rec.toolsOK = true
			for i := uint64(0); i < length; i++ {
				s, err := im.goStringAt(ptr + i*stringHeaderSize)
				if err != nil {
					// Record the failure in place so ordering stays visible.
					rec.tools = append(rec.tools, "<invalid:"+err.Error()+">")
					continue
				}
				rec.tools = append(rec.tools, s)
			}
		}
	} else {
		rec.toolsProblem = err.Error()
	}

	rec.ints = make([]uint64, 0, len(agentIntOffsets))
	for _, off := range agentIntOffsets {
		v, err := im.u64(a + off)
		if err != nil {
			rec.intsOK = false
			rec.intsErr = err
			break
		}
		rec.ints = append(rec.ints, v)
	}
	return rec
}

// intsColumn renders the -int-fields slots as "0x30=0x0;..." for -compact.
func (rec *agentRecord) intsColumn() string {
	if !rec.intsOK {
		return fmt.Sprintf("<invalid: %v>", rec.intsErr)
	}
	parts := make([]string, 0, len(agentIntOffsets))
	for i, off := range agentIntOffsets {
		parts = append(parts, fmt.Sprintf("0x%x=0x%x", off, rec.ints[i]))
	}
	return strings.Join(parts, ";")
}

// printAgent prints the multi-line record for one agent.
func (im *image) printAgent(rec *agentRecord, intFields bool) {
	name, typ := rec.name, rec.typ
	if !rec.nameOK {
		name = "<invalid>"
	}
	if !rec.typeOK {
		typ = "<invalid>"
	}
	if rec.toolsOK {
		fmt.Printf("AGENT addr=0x%x name=%q type=%q tools=%d\n", rec.addr, name, typ, len(rec.tools))
		for i, t := range rec.tools {
			fmt.Printf("  tool[%d]=%q\n", i, t)
		}
	} else {
		fmt.Printf("AGENT addr=0x%x name=%q type=%q tools=<invalid> len=%d ptr=0x%x problem=%q\n",
			rec.addr, name, typ, rec.toolsLen, rec.toolsPtr, rec.toolsProblem)
	}
	if intFields {
		if rec.intsOK {
			for i, off := range agentIntOffsets {
				fmt.Printf("  u64[0x%x]=0x%x\n", off, rec.ints[i])
			}
		} else {
			fmt.Printf("  u64=<invalid: %v>\n", rec.intsErr)
		}
	}
}

// printAgentCompact prints the tab-separated one-line form for one agent.
func (rec *agentRecord) printAgentCompact(intFields bool) {
	name, typ := rec.name, rec.typ
	if !rec.nameOK {
		name = "<invalid>"
	}
	if !rec.typeOK {
		typ = "<invalid>"
	}
	var tools, count string
	if rec.toolsOK {
		tools = strings.Join(rec.tools, ",")
		count = fmt.Sprint(len(rec.tools))
	} else {
		tools = fmt.Sprintf("tools=<invalid> len=%d ptr=0x%x problem=%q", rec.toolsLen, rec.toolsPtr, rec.toolsProblem)
		count = "<invalid>"
	}
	line := fmt.Sprintf("0x%x\t%s\t%s\t%s\t%s", rec.addr, name, typ, count, tools)
	if intFields {
		line += "\t" + rec.intsColumn()
	}
	fmt.Println(line)
}

// printStruct decodes n consecutive 16-byte headers from base.
func (im *image) printStruct(base uint64, n int) {
	name, secBase, ok := im.sectionAt(base, stringHeaderSize)
	if ok {
		fmt.Printf("# struct addr=0x%x section=%s offset=0x%x fields=%d\n",
			base, name, base-secBase, n)
	} else {
		fmt.Printf("# struct addr=0x%x section=<none> (%s) fields=%d\n",
			base, im.nearestSection(base), n)
	}
	for i := 0; i < n; i++ {
		im.printString(base+uint64(i)*stringHeaderSize, i)
	}
}

// printRaw resolves one address without interpreting it as a string.
func (im *image) printRaw(a uint64) {
	desc := im.describeAddr(a)
	if add, ok := im.relocs[a]; ok {
		target := im.describeAddr(add)
		line := fmt.Sprintf("raw addr=0x%x reloc=R_X86_64_RELATIVE addend=0x%x section=%s target_section=%s",
			a, add, desc, target)
		if preview, ok := im.preview(add); ok {
			line += fmt.Sprintf(" target=%q", preview)
		}
		fmt.Println(line)
		return
	}
	val, err := im.u64(a)
	if err != nil {
		fmt.Printf("raw addr=0x%x reloc=none section=%s error=%q\n", a, desc, err.Error())
		return
	}
	fmt.Printf("raw addr=0x%x reloc=none value=0x%x section=%s\n", a, val, desc)
}

// preview returns a short UTF-8 string at v, if there is one, for -raw output.
func (im *image) preview(v uint64) (string, bool) {
	n := uint64(48)
	off, avail, ok := im.fileOffset(v)
	if !ok || avail == 0 {
		return "", false
	}
	if avail < n {
		n = avail
	}
	buf := make([]byte, n)
	if _, err := im.src.ReadAt(buf, off); err != nil {
		return "", false
	}
	// Keep the longest valid UTF-8 prefix that is not empty.
	for i := len(buf); i > 0; i-- {
		if !utf8.Valid(buf[:i]) {
			continue
		}
		s := string(buf[:i])
		if s == "" {
			return "", false
		}
		return s, true
	}
	return "", false
}

// action is one requested operation, kept so the whole run can be ordered.
type action struct {
	addr   uint64
	kind   int // 0 = -addr, 1 = -struct, 2 = -raw, 3 = -agent
	fields int
}

func main() {
	if err := run(); err != nil {
		fmt.Fprintf(os.Stderr, "strhdr: %v\n", err)
		os.Exit(1)
	}
}

func run() error {
	var (
		binPath = flag.String("bin", "", "path to the ELF binary (read-only, never executed)")
		addrs   addrFlags
		structs addrFlags
		raws    addrFlags
		agents  addrFlags
		fields  = flag.Int("fields", 8, "number of 16-byte headers to decode per -struct")
		compact = flag.Bool("compact", false, "with -agent: print one tab-separated line per agent")
		ints    = flag.Bool("int-fields", false, "with -agent: also print u64 fields of unknown meaning")
	)
	flag.Var(&addrs, "addr", "decode one string header at this virtual address (repeatable)")
	flag.Var(&structs, "struct", "decode -fields consecutive string headers from this virtual address (repeatable)")
	flag.Var(&raws, "raw", "print the relocation addend for this virtual address without interpreting it (repeatable)")
	flag.Var(&agents, "agent", "decode one teamwork agent item struct at this virtual address (repeatable)")
	flag.Parse()

	if *binPath == "" {
		flag.Usage()
		return fmt.Errorf("-bin is required")
	}
	if *fields <= 0 || *fields > maxFields {
		return fmt.Errorf("-fields must be between 1 and %d, got %d", maxFields, *fields)
	}
	if len(addrs)+len(structs)+len(raws)+len(agents) == 0 {
		flag.Usage()
		return fmt.Errorf("no addresses given: use -addr, -struct, -raw or -agent")
	}

	src, err := os.Open(*binPath)
	if err != nil {
		return fmt.Errorf("open %s: %w", *binPath, err)
	}
	defer src.Close()
	f, err := elf.NewFile(src)
	if err != nil {
		return fmt.Errorf("parse %s as ELF: %w", *binPath, err)
	}
	defer f.Close()

	im := &image{f: f, src: src, order: f.ByteOrder}
	if err := im.loadRelocs(); err != nil {
		return err
	}

	acts := make([]action, 0, len(addrs)+len(structs)+len(raws)+len(agents))
	for _, a := range addrs {
		acts = append(acts, action{addr: a, kind: 0})
	}
	for _, a := range structs {
		acts = append(acts, action{addr: a, kind: 1, fields: *fields})
	}
	for _, a := range raws {
		acts = append(acts, action{addr: a, kind: 2})
	}
	for _, a := range agents {
		acts = append(acts, action{addr: a, kind: 3})
	}
	sort.SliceStable(acts, func(i, j int) bool {
		if acts[i].addr != acts[j].addr {
			return acts[i].addr < acts[j].addr
		}
		return acts[i].kind < acts[j].kind
	})

	for _, act := range acts {
		switch act.kind {
		case 0:
			if name, base, ok := im.sectionAt(act.addr, stringHeaderSize); ok {
				fmt.Printf("# addr=0x%x section=%s offset=0x%x\n", act.addr, name, act.addr-base)
			} else {
				fmt.Printf("# addr=0x%x section=<none> (%s)\n", act.addr, im.nearestSection(act.addr))
			}
			im.printString(act.addr, 0)
		case 1:
			im.printStruct(act.addr, act.fields)
		case 2:
			im.printRaw(act.addr)
		case 3:
			rec := im.decodeAgent(act.addr)
			if *compact {
				rec.printAgentCompact(*ints)
			} else {
				im.printAgent(rec, *ints)
			}
		}
	}
	return nil
}
