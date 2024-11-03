import { parse } from "https://deno.land/x/plist@0.0.1/mod.ts";
import { existsSync, moveSync, walk } from "jsr:@std/fs";

const SOFTWARE_UPD_URL =
	"https://swscan.apple.com/content/catalogs/others/index-14-13-12-10.16-10.15-10.14-10.13-10.12-10.11-10.10-10.9-mountainlion-lion-snowleopard-leopard.merged-1.sucatalog.gz";

async function main() {
	const macModel = prompt("Enter your Mac model (e.g. iMac12,2):", "iMac12,2");
	if (!macModel) {
		console.log("No Mac model provided.");
		return Deno.exit(1);
	}

	console.log(`Downloading Bootcamp Support Software for: ${macModel}`);
	console.log(`Downloading from: ${SOFTWARE_UPD_URL}`);

	const catalog = await retrieveSoftwareUpdateCatalog();
	const parsedCatalog = parse(catalog);

	const products = parsedCatalog.Products;

	// this ends up as [ [ "84-whatever", Product ], [ "85-whatever", Product ] ]
	const possibleBootCampProducts: [string, Product][] = [];

	for (const i in products) {
		const product = products[i];
		if (
			"ServerMetadataURL" in product &&
			product.ServerMetadataURL.includes("BootCamp")
		) {
			possibleBootCampProducts.push([i, product]);
		}
	}

	const bootCampProducts: [string, Product][] = [];
	const regexModel = "([a-zA-Z]{4,12}[1-9]{1,2}\,[1-6])";
	for (const [i, product] of possibleBootCampProducts) {
		if ("English" in product.Distributions) {
			const distributionUrl = product.Distributions.English;
			const dist = await (await fetch(distributionUrl)).text();
			if (dist.match(regexModel)) {
				const supportedModels = dist.matchAll(RegExp(regexModel, "g")).toArray()
					.map((m) => m[0]);
				if (supportedModels.includes(macModel)) {
					bootCampProducts.push([i, product]);
				}
			}
		}
	}

	if(bootCampProducts.length === 0) {
		console.log("No Bootcamp Support Software found for this Mac model.");
		return Deno.exit(1);
	}

	let chosenProduct: [string, Product] | undefined;

	for (const key in bootCampProducts) {
		console.log(`[${bootCampProducts[key][0]}] ${bootCampProducts[key][1].PostDate}`);
	}

	if(!confirm("Do you want to choose which Bootcamp Support Software to download?")) {
		chosenProduct = chooseLatestFrom(bootCampProducts);
	} else {
		const key = prompt("Enter the key of the Bootcamp Support Software you want to download:");
		if(!key) {
			console.log("No key provided.");
			chosenProduct = chooseLatestFrom(bootCampProducts);
		} else {
			for (const product of bootCampProducts) {
				if(product[0] === key) {
					chosenProduct = product;
					break;
				}
			}
			if(!chosenProduct) {
				console.log("Invalid key provided.");
				chosenProduct = chooseLatestFrom(bootCampProducts);
			}
		}
	}

	if (!chosenProduct) {
		console.log("No Bootcamp Support Software found for this Mac model.");
		return Deno.exit(1);
	}

	console.log(
		`\nChoosing latest Bootcamp Support Software: ${chosenProduct[0]}`,
	);

	const downloadURL = chosenProduct[1].Packages[0].URL;

	const workDir = Deno.cwd() + `/BC-${chosenProduct[0]}/`;
	const fullWorkDir = workDir + "BootCampSupport.pkg";

	if (!existsSync(workDir)) {
		await Deno.mkdir(workDir);
	}
	if (!existsSync(fullWorkDir)) {
		await doVisualDownload(downloadURL, fullWorkDir);
	}

	// console.clear();
	if (Deno.build.os === "darwin") {
		console.log("Extracting Bootcamp Support Software...");
		await runCommand("pkgutil", ["--expand", fullWorkDir, workDir + "pkg"]) ===
				true
			? console.log("Extracted .pkg, moving onto payload extraction...")
			: "";
		await runCommand("tar", [
				"-xz",
				"-C",
				workDir,
				"-f",
				workDir + "pkg/Payload",
			]) === true
			? console.log("Extracted payload, finding Bootcamp Windows DMG...")
			: "";

		const dmg = await expandGlobSync(/.*\.dmg$/, { root: workDir });
		if (dmg) {
			const mvDir = Deno.cwd() + "/BootcampSupportSoftware.dmg"
			if(!existsSync(mvDir)) {
				moveSync(dmg, mvDir);
			}

			if(confirm("Do you want to delete the extracted files?")) {
				await Deno.remove(workDir, {recursive: true});
			}
		}

		console.log("Done!");
	} else {
		console.log(
			"To extract the Bootcamp Support Software automatically, please run this script on a Mac.",
		);
		console.log(
			"Otherwise, you can extract the Bootcamp Support Software manually.",
		);
	}

	// const bootcampProduct = bootcampProducts[0];
	// console.log(`Bootcamp Product: ${bootcampProduct}`);
}

async function retrieveSoftwareUpdateCatalog(): Promise<string> {
	return await (await fetch(SOFTWARE_UPD_URL)).text();
}

async function doVisualDownload(url: string, path: string) {
	console.log(`Downloading to: ${path}`);

	const res = await fetch(url);
	const contentLength = res.headers.get("content-length");
	if (!contentLength) {
		throw new Error("No content length provided!");
	}

	const total = parseInt(contentLength, 10);
	let downloaded = 0;

	const file = await Deno.open(path, { write: true, create: true });

	const reader = res.body?.getReader();
	if (!reader) {
		throw new Error("No reader provided!");
	}

	while (true) {
		const { done, value } = await reader.read();
		if (done) {
			console.log("\nDownload complete!");
			break;
		}

		if (value) {
			await file.write(value);
			downloaded += value.length;
			Deno.stdout.write(
				new TextEncoder().encode(
					`\rDownloading: ${((downloaded / total) * 100).toFixed(2)}%`,
				),
			);
		}
	}
}

async function runCommand(command: string, args: string[]) {
	const p = new Deno.Command(command, {
		stdout: "piped",
		stderr: "piped",
		args: args,
	});

	const o = await p.output();
	if (!o.success) {
		console.log(new TextDecoder().decode(o.stderr));
	}

	return o.success;
}

async function expandGlobSync(pattern: RegExp, options: { root: string }) {
	for await (const entry of walk(options.root)) {
		if (entry.isFile && entry.name.match(pattern)) {
			return entry.path;
		}
	}
}

function chooseLatestFrom(bootCampProducts: [string, Product][]) {
	var chosenProduct: [string, Product] | undefined;

	for (const key in bootCampProducts) {
		if (!chosenProduct) {
			chosenProduct = [bootCampProducts[key][0], bootCampProducts[key][1]];
		}

		const currentProduct = bootCampProducts[key];
		const chosenProductDate = new Date(chosenProduct[1].PostDate);
		const currentProductDate = new Date(currentProduct[1].PostDate);

		if (currentProductDate > chosenProductDate) {
			chosenProduct = [bootCampProducts[key][0], currentProduct[1]];
		}
	}

	return chosenProduct;
}

interface Product {
	PostDate: string;
	ServerMetadataURL: string;
	Distributions: { [key: string]: string };
	Packages: { [key: string]: Package };
}

interface Package {
	Digest: string;
	Size: number;
	URL: string;
}

if (import.meta.main) {
	await main();
}
