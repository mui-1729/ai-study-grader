// Synthetic public fixture with a correct xref table; padding exercises file-byte limits.
export function textPDF(pageCount = 1, paddingBytes = 0): Buffer {
  const content =
    'BT /F1 12 Tf 40 700 Td (This is a synthetic material for testing the large PDF upload limit.) Tj ET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${Array.from({ length: pageCount }, (_, i) => `${i + 5} 0 R`).join(' ')}] /Count ${pageCount} >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    ...Array.from(
      { length: pageCount },
      () =>
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents 4 0 R >>',
    ),
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${object}\nendobj\n`;
  });
  if (paddingBytes) pdf += '%' + ' '.repeat(paddingBytes) + '\n';
  const xref = pdf.length;
  pdf +=
    `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` +
    offsets
      .slice(1)
      .map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`)
      .join('');
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, 'ascii');
}

export async function imagePDF(pngs: Buffer[]): Promise<Buffer> {
  const { createCanvas, loadImage } = await import('@napi-rs/canvas');
  const objects: Buffer[] = [];
  const add = (value: string | Buffer) => {
    objects.push(typeof value === 'string' ? Buffer.from(value) : value);
    return objects.length;
  };
  add('<< /Type /Catalog /Pages 2 0 R >>');
  add('');
  const pages: number[] = [];
  for (const png of pngs) {
    const image = await loadImage(png),
      canvas = createCanvas(image.width, image.height);
    canvas.getContext('2d').drawImage(image, 0, 0);
    const jpg = await canvas.encode('jpeg');
    canvas.width = canvas.height = 1;
    const imageId = add(
      Buffer.concat([
        Buffer.from(
          `<< /Type /XObject /Subtype /Image /Width ${image.width} /Height ${image.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpg.length} >>\nstream\n`,
        ),
        jpg,
        Buffer.from('\nendstream'),
      ]),
    );
    const content = `q 600 0 0 263 0 0 cm /Image Do Q`;
    const stream = add(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
    pages.push(
      add(
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 263] /Resources << /XObject << /Image ${imageId} 0 R >> >> /Contents ${stream} 0 R >>`,
      ),
    );
  }
  objects[1] = Buffer.from(
    `<< /Type /Pages /Count ${pages.length} /Kids [${pages.map((id) => `${id} 0 R`).join(' ')}] >>`,
  );
  const parts = [Buffer.from('%PDF-1.4\n')],
    offsets = [0];
  let size = parts[0]!.length;
  objects.forEach((object, i) => {
    offsets.push(size);
    const part = Buffer.concat([
      Buffer.from(`${i + 1} 0 obj\n`),
      object,
      Buffer.from('\nendobj\n'),
    ]);
    parts.push(part);
    size += part.length;
  });
  parts.push(
    Buffer.from(
      `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets
        .slice(1)
        .map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`)
        .join(
          '',
        )}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${size}\n%%EOF\n`,
    ),
  );
  return Buffer.concat(parts);
}
