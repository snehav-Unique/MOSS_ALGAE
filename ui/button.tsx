import {Slot} from '@radix-ui/react-slot';
import {cva} from 'class-variance-authority';
import {clsx} from 'clsx';
import {twMerge} from 'tailwind-merge';
const variants=cva('button',{variants:{variant:{default:'primary',outline:'outline'}},defaultVariants:{variant:'default'}});
export function Button({asChild=false,variant='default',className,...props}:React.ButtonHTMLAttributes<HTMLButtonElement>&{asChild?:boolean;variant?:'default'|'outline'}){const Comp=asChild?Slot:'button';return <Comp className={twMerge(clsx(variants({variant}),className))} {...props}/>}
