/* eslint-disable @typescript-eslint/no-explicit-any */
import { attemptAsync } from 'ts-utils/check';
import {
	DataVersion,
	Struct,
	StructData,
	type Blank,
	type Structable
} from 'drizzle-struct/back-end';
import fs from 'fs';
import path from 'path';
import { select, selectFromTable, repeatPrompt, confirm, prompt, multiSelect } from './utils';
import { checkStrType, returnType } from 'drizzle-struct/utils';
// import { Permissions } from '../structs/permissions';

export const openStructs = (dir: string) =>
	attemptAsync(async () => {
		const readFile = async (file: string): Promise<Struct[]> => {
			try {
				if (file.includes('test')) return []; // Skip test struct files
				const data = await import(file);

				const structs: Struct[] = [];

				const open = (obj: Record<string, unknown>) => {
					for (const key in obj) {
						if (key.startsWith('_')) continue;
						if (obj[key] instanceof Struct) {
							structs.push(obj[key] as Struct);
						} else if (typeof obj[key] === 'object') {
							open(obj[key] as Record<string, unknown>);
						}
					}
				};

				open(data);

				return structs;
			} catch (err) {
				console.error(err);
				return [];
			}
		};

		const readdir = async (dir: string): Promise<Struct[]> => {
			const contents = await fs.promises.readdir(dir);
			const res = await Promise.all(
				contents.map(async (object) => {
					if (fs.lstatSync(path.join(dir, object)).isDirectory()) {
						return readdir(path.join(dir, object));
					}
					return readFile(path.join(dir, object));
				})
			);

			return res.flat();
		};

		const res = await readdir(dir);

		return res.sort((a, b) => a.name.localeCompare(b.name)).filter((s) => !s.data.sample);
	});

export const selectStruct = (structs: Struct[], message?: string) =>
	select({
		clear: true,
		message: message || 'Select a struct',
		options: structs.map((s) => ({
			name: s.name,
			value: s
		}))
	});

export const selectData = <T extends StructData>(
	data: T[],
	message?: string,
	options?: {
		omit?: (keyof T['data'])[];
	}
) =>
	selectFromTable({
		clear: true,
		message: message || 'Select a data',
		options: data.map((d) => d.data),
		omit: options?.omit as string[]
	});

export const selectDataPipe = <S extends Struct>(
	struct: S,
	data: StructData<S['data']['structure'], S['data']['name']>[],
	next?: Next
) =>
	attemptAsync(async () => {
		const res = (await selectData(data, `Select from ${struct.name}`)).unwrap();
		if (res === undefined) {
			return doNext('No data selected', undefined, next);
		}

		return selectDataAction(data[res], next);
	});

type Next = (message: string, error?: Error) => Promise<void> | void;

const doNext = (message: string, error?: Error, next?: Next) => {
	if (next) return next(message, error);
	if (error) throw error;
	console.log(message);
};

export const structActions = {
	new: async <T extends Struct>(
		struct: T,
		next?: Next,
		additions?: Partial<Structable<T['data']['structure']>>
	) =>
		attemptAsync(async () => {
			const properties = Object.entries(struct.data.structure);

			console.log(
				`
Type instructions:
Booleans: y = true, n = false, 1 = true, 0 = false, true = true, false = false
Text: Anything
Integers: Whole numbers
Reals: Decimal numbers
Bigints: Numbers above 2^53

If something is a date, use the exact format ${new Date().toISOString()},
otherwise dates will not work.
        `.trim()
			);

			const data: Record<string, unknown> = {};

			for (const p of properties) {
				const [key, type] = p;
				if (additions && additions[key]) {
					data[key] = additions[key];
					continue;
				}
				const res = (
					await repeatPrompt({
						message: `Enter a value for ${key} (${(type as any).config.dataType})`,
						validate: (str) => checkStrType(str, (type as any).config.dataType)
					})
				).unwrap();

				data[key] = returnType(res, (type as any).config.dataType);
			}

			const res = await struct.new(data as Structable<T['data']['structure']>);

			if (res.isErr()) {
				console.error(res.error);
				return async () => {
					console.log('Failed to create new data');
					const confirmed = (await confirm({ message: 'Try again?' })).unwrap();
					if (confirmed) {
						await structActions.new(struct);
					} else {
						return doNext('No new data created', res.error, next);
					}
				};
			}

			return doNext('New data created', undefined, next);
		}),
	all: async <T extends Struct>(struct: T, next?: Next) =>
		attemptAsync(async () => {
			const all = (await struct.all(false)).unwrap();
			return selectDataPipe(struct, all, next);
		}),
	fromProperty: async <T extends Struct>(struct: T, next?: Next) =>
		attemptAsync(async () => {
			const res = (
				await select({
					clear: true,
					message: `Select a property from ${struct.name}`,
					options: Object.keys(struct.data.structure).map((k) => ({
						name: k,
						value: k
					}))
				})
			).unwrap();

			if (!res) {
				return doNext('No property selected', undefined, next);
			}

			const value = (
				await repeatPrompt({
					clear: true,
					message: `Enter a value for ${res} (${struct.data.structure[res]})`,
					validate: (str) => checkStrType(str, (struct.data.structure[res] as any).config.dataType)
				})
			).unwrap();

			const data = (await struct.fromProperty(res, value, false)).unwrap();
			return selectDataPipe(struct, data, next);
		}),
	// fromUniverse: async <T extends Struct>(struct: T, next?: Next) =>
	// 	attemptAsync(async () => {
	// 		const universes = (await Permissions.Universe.all(false)).unwrap();
	// 		const res = (
	// 			await select({
	// 				message: 'Select a universe',
	// 				options: universes.map((u) => ({
	// 					name: u.data.name,
	// 					value: u
	// 				}))
	// 			})
	// 		).unwrap();

	// 		if (!res) {
	// 			return doNext('No universe selected', undefined, next);
	// 		}

	// 		const data = (await struct.fromUniverse(res.id, false)).unwrap();
	// 		return selectDataPipe(struct, data, next);
	// 	}),
	archived: async <T extends Struct>(struct: T, next?: Next) =>
		attemptAsync(async () => {
			const data = (await struct.archived(false)).unwrap();
			return selectDataPipe(struct, data, next);
		}),
	clear: async <T extends Struct>(struct: T, next?: Next) =>
		attemptAsync(async () => {
			if ((await confirm({ message: 'Are you sure you want to clear all data?' })).unwrap()) {
				const res = await struct.clear();
				if (res.isErr()) {
					console.error(res.error);
					return doNext('Failed to clear data', res.error, next);
				}

				return doNext('Data cleared', undefined, next);
			}

			return doNext('Data not cleared', undefined, next);
		})
};

export const selectStuctAction = (struct: Struct, next?: Next) =>
	attemptAsync(async () => {
		const entries = Object.entries(structActions);
		const res = (
			await select({
				clear: true,
				message: 'Select an action',
				options: entries.map(([key, value]) => ({
					name: key,
					value
				}))
			})
		).unwrap();
		if (!res) {
			return doNext('No action selected', undefined, next);
		}

		return (await res(struct, next)).unwrap();
	});

export const dataActions = {
	update: async <S extends StructData>(data: S, next?: Next) =>
		attemptAsync(async () => {
			const properties = Object.entries(data.data.structure);

			const newData: Record<string, unknown> = {};

			for (const p of properties) {
				const [key, type] = p;
				const res = (
					await repeatPrompt({
						message: `Enter a new value for ${key} (${type})`,
						allowBlank: true,
						validate: (str) => checkStrType(str, (type as any).config.dataType)
					})
				).unwrap();
				if (!res) continue;

				newData[key] = returnType(res, (type as any).config.dataType);
			}

			const res = await data.update(newData as Partial<Structable<Blank>>);

			if (res.isErr()) {
				console.error(res.error);
				return async () => {
					console.log('Failed to update data');
					const confirmed = (await confirm({ message: 'Try again?' })).unwrap();
					if (confirmed) {
						await dataActions.update(data);
					} else {
						return doNext('No data updated', res.error, next);
					}
				};
			}

			return doNext('Data updated', undefined, next);
		}),
	delete: async (data: StructData, next?: Next) =>
		attemptAsync(async () => {
			if ((await confirm({ message: 'Are you sure you want to delete this data?' })).unwrap()) {
				const res = await data.delete();
				if (res.isErr()) {
					console.error(res.error);
					return doNext('Failed to delete data', res.error, next);
				}

				return doNext('Data deleted', undefined, next);
			}

			return doNext('Data not deleted', undefined, next);
		}),
	archive: async (data: StructData, next?: Next) =>
		attemptAsync(async () => {
			if ((await confirm({ message: 'Are you sure you want to archive this data?' })).unwrap()) {
				const res = await data.setArchive(true);
				if (res.isErr()) {
					console.error(res.error);
					return doNext('Failed to archive data', res.error, next);
				}

				return doNext('Data archived', undefined, next);
			}

			return doNext('Data not archived', undefined, next);
		}),
	restore: async (data: StructData, next?: Next) =>
		attemptAsync(async () => {
			if ((await confirm({ message: 'Are you sure you want to restore this data?' })).unwrap()) {
				const res = await data.setArchive(false);
				if (res.isErr()) {
					console.error(res.error);
					return doNext('Failed to restore data', res.error, next);
				}

				return doNext('Data restored', undefined, next);
			}

			return doNext('Data not restored', undefined, next);
		}),
	versionHistory: async (data: StructData, next?: Next) =>
		attemptAsync(async () => {
			const versions = (await data.getVersions()).unwrap();
			return selectVersionPipe(versions, next);
		}),
	addAttributes: async (data: StructData, next?: Next) =>
		attemptAsync(async () => {
			const current = data.getAttributes().unwrap();
			console.log('Current attributes:', current);

			const res = (
				await prompt({
					message: 'Enter new attributes separated by commas'
				})
			).unwrap();

			if (!res) {
				return doNext('No attributes added', undefined, next);
			}

			const attributes = res.split(',').map((a) => a.trim());
			const res2 = await data.addAttributes(...attributes);

			if (res2.isErr()) {
				console.error(res2.error);
				return doNext('Failed to add attributes', res2.error, next);
			}

			return doNext('Attributes added', undefined, next);
		}),
	removeAttributes: async (data: StructData, next?: Next) =>
		attemptAsync(async () => {
			const current = data.getAttributes().unwrap();
			console.log('Current attributes:', current);

			const res = (
				await prompt({
					message: 'Enter attributes to remove separated by commas'
				})
			).unwrap();

			if (!res) {
				return doNext('No attributes removed', undefined, next);
			}

			const attributes = res.split(',').map((a) => a.trim());
			const res2 = await data.removeAttributes(...attributes);

			if (res2.isErr()) {
				console.error(res2.error);
				return doNext('Failed to remove attributes', res2.error, next);
			}

			return doNext('Attributes removed', undefined, next);
		}),
	setAttributes: async (data: StructData, next?: Next) =>
		attemptAsync(async () => {
			const res = (
				await prompt({
					clear: true,
					message: 'Enter new attributes separated by commas'
				})
			).unwrap();

			if (!res) {
				return doNext('No attributes set', undefined, next);
			}

			const attributes = res.split(',').map((a) => a.trim());
			const res2 = await data.setAttributes(attributes);

			if (res2.isErr()) {
				console.error(res2.error);
				return doNext('Failed to set attributes', res2.error, next);
			}

			return doNext('Attributes set', undefined, next);
		}),
	// addToUniverse: async (data: StructData, next?: Next) =>
	// 	attemptAsync(async () => {
	// 		const universes = (await Permissions.Universe.all(false)).unwrap();
	// 		const res = (
	// 			await select({
	// 				clear: true,
	// 				message: 'Select a universe',
	// 				options: universes.map((u) => ({
	// 					name: u.data.name,
	// 					value: u
	// 				}))
	// 			})
	// 		).unwrap();

	// 		if (!res) {
	// 			return doNext('No universe selected', undefined, next);
	// 		}

	// 		const res2 = await data.addUniverses(res.id);

	// 		if (res2.isErr()) {
	// 			console.error(res2.error);
	// 			return doNext('Failed to add data to universe', res2.error, next);
	// 		}

	// 		return doNext('Data added to universe', undefined, next);
	// 	}),
	// setUniverses: async (data: StructData, next?: Next) =>
	// 	attemptAsync(async () => {
	// 		const universes = (await Permissions.Universe.all(false)).unwrap();
	// 		const res = (
	// 			await multiSelect({
	// 				message: 'Select universes',
	// 				options: universes.map((u) => ({
	// 					name: u.data.name,
	// 					value: u
	// 				}))
	// 			})
	// 		).unwrap();

	// 		if (!res) {
	// 			return doNext('No universes selected', undefined, next);
	// 		}

	// 		const res2 = await data.setUniverses(res.map((r) => r.id));

	// 		if (res2.isErr()) {
	// 			console.error(res2.error);
	// 			return doNext('Failed to set universes', res2.error, next);
	// 		}

	// 		return doNext('Universes set', undefined, next);
	// 	}),
	// removeFromUniverse: async (data: StructData, next?: Next) =>
	// 	attemptAsync(async () => {
	// 		const universes = (await Permissions.Universe.all(false)).unwrap();
	// 		const current = data
	// 			.getUniverses()
	// 			.unwrap()
	// 			.map((u) => universes.find((u2) => u2.id === u))
	// 			.filter(Boolean) as Permissions.UniverseData[];

	// 		const res = (
	// 			await select({
	// 				clear: true,
	// 				message: 'Select a universe',
	// 				options: current.map((u) => ({
	// 					name: u.data.name,
	// 					value: u
	// 				}))
	// 			})
	// 		).unwrap();

	// 		if (!res) {
	// 			return doNext('No universe selected', undefined, next);
	// 		}

	// 		const res2 = await data.removeUniverses(res.id);

	// 		if (res2.isErr()) {
	// 			console.error(res2.error);
	// 			return doNext('Failed to remove data from universe', res2.error, next);
	// 		}

	// 		return doNext('Data removed from universe', undefined, next);
	// 	})
};

export const selectDataAction = (data: StructData, next?: Next) =>
	attemptAsync(async () => {
		const entries = Object.entries(dataActions);
		const res = (
			await select({
				clear: true,
				message: 'Select an action',
				options: entries.map(([key, value]) => ({
					name: key,
					value
				}))
			})
		).unwrap();
		if (!res) {
			return console.log('No action selected');
		}

		return res(data, next);
	});

export const versionActions = {
	restore: async (version: DataVersion<Blank, string>, next?: Next) =>
		attemptAsync(async () => {
			if (
				(
					await confirm({
						clear: true,
						message: 'Are you sure you want to restore this version?'
					})
				).unwrap()
			) {
				const res = await version.restore();
				if (res.isErr()) {
					console.error(res.error);
					return doNext('Failed to restore version', res.error, next);
				}

				return doNext('Version restored', undefined, next);
			}

			return doNext('Version not restored', undefined, next);
		}),
	delete: async (version: DataVersion<Blank, string>, next?: Next) =>
		attemptAsync(async () => {
			if (
				(
					await confirm({
						clear: true,
						message: 'Are you sure you want to delete this version?'
					})
				).unwrap()
			) {
				const res = await version.delete();
				if (res.isErr()) {
					console.error(res.error);
					return doNext('Failed to delete version', res.error, next);
				}

				return doNext('Version deleted', undefined, next);
			}

			return doNext('Version not deleted', undefined, next);
		})
};

export const selectVersion = (versions: DataVersion<Blank, string>[], message?: string) =>
	selectFromTable({
		clear: true,
		message: message || 'Select a version',
		options: versions.map((v) => v.data)
	});

export const selectVersionAction = (version: DataVersion<Blank, string>, next?: Next) =>
	attemptAsync(async () => {
		const entries = Object.entries(versionActions);
		const res = (
			await select({
				clear: true,
				message: 'Select an action',
				options: entries.map(([key, value]) => ({
					name: key,
					value
				}))
			})
		).unwrap();
		if (!res) {
			return doNext('No action selected', undefined, next);
		}

		return res(version, next);
	});

export const selectVersionPipe = (versions: DataVersion<Blank, string>[], next?: Next) =>
	attemptAsync(async () => {
		const res = (await selectVersion(versions)).unwrap();
		if (res === undefined) {
			return doNext('No version selected', undefined, next);
		}

		return selectVersionAction(versions[res], next);
	});

// export const structsPipe = () => attemptAsync(async () => {
//     const structs = (await openStructs()).unwrap();
//     const selected = (await selectStruct(structs)).unwrap();
//     if (!selected) {
//         return console.log('No struct selected');
//     }
//     (await selectStuctAction(selected, (message, err) => {
//         if (err) throw err;
//         console.log(message);
//         structsPipe();
//     })).unwrap();
// });
