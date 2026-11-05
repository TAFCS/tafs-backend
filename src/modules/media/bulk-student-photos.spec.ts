import { MediaService } from './media.service';
import { parseCcFilename, photoContentHash, studentPhotoKey } from './student-photo-key.util';

/** TAFSD-483: bulk student photo upload keeps every photo and never double-imports. */

function file(name: string, content = name): Express.Multer.File {
  return { originalname: name, buffer: Buffer.from(content), mimetype: 'image/jpeg' } as any;
}

function setup(students: Array<{ cc: number; photograph_url?: string | null }>, historyUrls: string[] = []) {
  const prisma: any = {
    students: {
      findMany: jest.fn().mockResolvedValue(
        students.map((s) => ({
          cc: s.cc,
          full_name: `Student ${s.cc}`,
          gr_number: String(s.cc),
          photograph_url: s.photograph_url ?? null,
          classes: { description: 'JR. I' },
          sections: { description: 'A' },
        })),
      ),
      update: jest.fn().mockReturnValue('update-op'),
    },
    student_photo_history: {
      findMany: jest.fn().mockResolvedValue(historyUrls.map((url) => ({ url }))),
      create: jest.fn().mockReturnValue('history-op'),
    },
    $transaction: jest.fn().mockResolvedValue([]),
  };
  const storage: any = { upload: jest.fn(async (key: string) => `https://cdn.test/${key}`) };
  const auditLogs: any = { log: jest.fn() };
  return { service: new MediaService(prisma, storage, auditLogs), prisma, storage };
}

describe('parseCcFilename', () => {
  it('accepts CC-only names in jpg/jpeg/png, any case', () => {
    expect(parseCcFilename('1234.jpg')).toEqual({ cc: 1234, ext: 'jpg' });
    expect(parseCcFilename('folder/77.PNG')).toEqual({ cc: 77, ext: 'png' });
    expect(parseCcFilename('5.jpeg')).toEqual({ cc: 5, ext: 'jpeg' });
  });
  it('rejects anything else', () => {
    for (const bad of ['ALI 1234.jpg', '1234.gif', '1234', '0.jpg', '12a.jpg', '1234 (1).jpg']) {
      expect(parseCcFilename(bad)).toBeNull();
    }
  });
});

describe('studentPhotoKey', () => {
  it('builds a unique, hash-tagged key per upload', () => {
    const at = new Date(1_700_000_000_000);
    expect(studentPhotoKey(42, 'standard', 'JPG', 'abc123def456', at)).toBe(
      'media/students/42/standard-1700000000000-abc123def456.jpg',
    );
  });
});

describe('MediaService bulk student photos', () => {
  it('preview flags bad names, unknown CCs and repeated CCs', async () => {
    const { service } = setup([{ cc: 10 }, { cc: 11 }]);
    const rows = await service.previewBulkStudentPhotos(
      ['10.jpg', 'ALI 11.jpg', '99.jpg', '11.jpg', '11.png'],
      {},
    );
    expect(rows.map((r) => r.status)).toEqual([
      'ready',
      'invalid_name',
      'not_found',
      'duplicate_cc',
      'duplicate_cc',
    ]);
    expect(rows[0].student?.class_name).toBe('JR. I');
  });

  it('stores a new object, sets it current and adds a history row; never deletes the old one', async () => {
    const { service, prisma, storage } = setup([{ cc: 10, photograph_url: 'https://cdn.test/old.jpg' }]);
    const [row] = await service.bulkUploadStudentPhotos([file('10.jpg')], {}, 'tester');

    expect(row.status).toBe('uploaded');
    const key = storage.upload.mock.calls[0][0] as string;
    expect(key).toMatch(new RegExp(`^media/students/10/standard-\\d+-${photoContentHash(Buffer.from('10.jpg'))}\\.jpg$`));
    expect(prisma.students.update).toHaveBeenCalledWith({ where: { cc: 10 }, data: { photograph_url: row.url } });
    expect(prisma.student_photo_history.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ student_id: 10, url: row.url, uploaded_by: 'tester' }) }),
    );
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it('skips an image already in the history (re-running a batch is harmless)', async () => {
    const hash = photoContentHash(Buffer.from('same-bytes'));
    const { service, storage, prisma } = setup(
      [{ cc: 10 }],
      [`https://cdn.test/media/students/10/standard-1-${hash}.jpg`],
    );
    const [row] = await service.bulkUploadStudentPhotos([file('10.jpg', 'same-bytes')], {}, 'tester');
    expect(row.status).toBe('already_uploaded');
    expect(storage.upload).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('reports a storage failure per file without stopping the batch', async () => {
    const { service, storage } = setup([{ cc: 10 }, { cc: 11 }]);
    storage.upload.mockRejectedValueOnce(new Error('Spaces down'));
    const rows = await service.bulkUploadStudentPhotos([file('10.jpg'), file('11.jpg')], {}, 'tester');
    expect(rows.map((r) => r.status)).toEqual(['error', 'uploaded']);
  });
});
